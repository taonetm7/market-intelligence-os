import { execSync } from "node:child_process";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureSearchIndex, searchRawSignalIds } from "../../lib/db/search";
import { originSchema, sourceTypeSchema } from "../../lib/validation/enums";

// task-40 — Postgres スモークテスト（spec v2 §6.3 / §18.7）。
//
// **Postgres 起動時のみ走る**。`DATABASE_PROVIDER=postgres`（かつ `DATABASE_URL=postgresql://...`）が
// 設定されていない通常 CI（SQLite）では describe ごとスキップされ、既存テスト群の全 green を壊さない。
//
// 実行手順（docs/postgres-migration.md）:
//   docker compose up -d
//   export DATABASE_PROVIDER=postgres
//   export DATABASE_URL="postgresql://mi:mi@localhost:5432/market_intel?schema=public"
//   pnpm exec prisma generate --schema prisma/schema.postgres.prisma
//   pnpm test tests/db/pg-smoke.test.ts
//
// 検証内容: 接続 / "enum" 相当を String で保存・読み出し / 全文検索（pg_trgm + ILIKE）で
// CJK・英数の部分一致が引けること。テスト行は displayId 接頭辞で隔離し、後始末で削除する
// （既存 Postgres データは壊さない）。import は相対パス（@/ は vitest 非対応）。

const provider = (process.env.DATABASE_PROVIDER ?? "sqlite").trim().toLowerCase();
const isPgEnv = provider === "postgres" || provider === "postgresql";
const PREFIX = "RS-PGSMOKE-";

let db: PrismaClient;

describe.skipIf(!isPgEnv)("Postgres スモーク（DATABASE_PROVIDER=postgres のときのみ）", () => {
  beforeAll(async () => {
    // スキーマを冪等に用意する（Postgres 用 schema・既存データは壊さない）。
    execSync("pnpm exec prisma db push --schema prisma/schema.postgres.prisma --skip-generate", {
      env: { ...process.env },
      stdio: "ignore",
    });
    db = new PrismaClient();
    await ensureSearchIndex(db); // pg_trgm 拡張 + GIN trigram 索引
    await db.rawSignal.deleteMany({ where: { displayId: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    if (db) {
      await db.rawSignal.deleteMany({ where: { displayId: { startsWith: PREFIX } } });
      await db.$disconnect();
    }
  });

  it("Postgres へ接続できる", async () => {
    const rows = await db.$queryRawUnsafe<{ ok: number }[]>(`SELECT 1 AS ok`);
    expect(rows[0]?.ok).toBe(1);
  });

  it('"enum" 相当（sourceType / origin）を String 列で保存・読み出しできる', async () => {
    const created = await db.rawSignal.create({
      data: {
        displayId: `${PREFIX}1`,
        sourceType: sourceTypeSchema.enum.review,
        rawText: "postgres enum-as-string 確認",
        origin: originSchema.enum.ai,
      },
    });
    const found = await db.rawSignal.findUnique({ where: { id: created.id } });
    expect(found?.sourceType).toBe(sourceTypeSchema.enum.review);
    expect(found?.origin).toBe(originSchema.enum.ai);
  });

  it("全文検索（pg_trgm + ILIKE）で日本語の部分一致が引ける", async () => {
    const hit = await db.rawSignal.create({
      data: {
        displayId: `${PREFIX}2`,
        sourceType: sourceTypeSchema.enum.review,
        rawText: "日本語の全文検索テストを実施",
        observedEntity: "テスト株式会社",
      },
    });
    await db.rawSignal.create({
      data: {
        displayId: `${PREFIX}3`,
        sourceType: sourceTypeSchema.enum.review,
        rawText: "無関係な観測データ",
      },
    });

    expect(await searchRawSignalIds("全文検索", db)).toContain(hit.id);
    // observedEntity 側の部分一致。
    expect(await searchRawSignalIds("株式会社", db)).toContain(hit.id);
    // 無関係語はヒットしない。
    expect(await searchRawSignalIds("全文検索", db)).not.toContain(`${PREFIX}3`);
  });

  it("英数 substring も部分一致で引ける", async () => {
    const hit = await db.rawSignal.create({
      data: {
        displayId: `${PREFIX}4`,
        sourceType: sourceTypeSchema.enum.review,
        rawText: "needle in the haystack",
      },
    });
    expect(await searchRawSignalIds("needle", db)).toContain(hit.id);
  });

  it("空クエリは空配列（検索しない）", async () => {
    expect(await searchRawSignalIds("   ", db)).toEqual([]);
  });
});
