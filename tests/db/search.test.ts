import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { rawSignalRepo } from "../../lib/db/rawSignalRepo";
import {
  RAW_SIGNAL_FTS_TABLE,
  reindexAll,
  search,
  searchRawSignalIds,
  toMatchQuery,
} from "../../lib/db/search";

// task-33 — RawSignal 全文検索（SQLite FTS5・trigram）。spec v2 §9.3 / §18.1。
// 他の DB テストと違い、ここは raw SQL migration（FTS 仮想テーブル＋トリガ＋backfill）の検証が目的
// のため、`prisma db push` ではなく `prisma migrate deploy` でマイグレーションを実適用する。
// これにより「migration で仮想テーブル＋トリガが作られる」「既存行が再インデックスされる」を本物の
// 経路で確かめる。import は相対パス（@/ は vitest 非対応）。dev.db は触らない。

let dbDir: string;
let db: PrismaClient;
let seq = 0;

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-search-"));
  const url = `file:${join(dbDir, "test.db")}`;
  // migration を実適用（init → quarantine → fts5）。FTS 仮想テーブル/トリガは fts migration が作る。
  execSync("pnpm exec prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  db = new PrismaClient({ datasources: { db: { url } } });
});

afterAll(async () => {
  await db.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // DELETE トリガが FTS も掃除する（同期の確認も兼ねる）。
  await db.evidence.deleteMany();
  await db.rawSignal.deleteMany();
});

async function createSignal(rawText: string, observedEntity?: string): Promise<{ id: string }> {
  seq += 1;
  return db.rawSignal.create({
    data: {
      displayId: `RS-FTS-${seq}`,
      sourceType: "review",
      rawText,
      observedEntity: observedEntity ?? null,
    },
  });
}

describe("toMatchQuery", () => {
  it("クエリ全体をフレーズ（部分一致）にし、二重引用符をエスケープする", () => {
    expect(toMatchQuery("値上げ")).toBe('"値上げ"');
    expect(toMatchQuery("  match me  ")).toBe('"match me"');
    expect(toMatchQuery('a "b" c')).toBe('"a ""b"" c"');
  });

  it("空・空白のみは null", () => {
    expect(toMatchQuery("")).toBeNull();
    expect(toMatchQuery("   ")).toBeNull();
  });
});

describe("FTS5 migration（仮想テーブル＋トリガ）", () => {
  it("migration で仮想テーブルと 3 つの同期トリガが作られている", async () => {
    const rows = await db.$queryRawUnsafe<{ name: string; type: string }[]>(
      `SELECT name, type FROM sqlite_master WHERE name LIKE '${RAW_SIGNAL_FTS_TABLE}%'`,
    );
    const names = rows.map((r) => r.name);
    expect(names).toContain(RAW_SIGNAL_FTS_TABLE);
    expect(names).toContain(`${RAW_SIGNAL_FTS_TABLE}_ai`);
    expect(names).toContain(`${RAW_SIGNAL_FTS_TABLE}_ad`);
    expect(names).toContain(`${RAW_SIGNAL_FTS_TABLE}_au`);
  });
});

describe("searchRawSignalIds（INSERT/UPDATE/DELETE 同期）", () => {
  it("INSERT がトリガで索引へ反映される（rawText / observedEntity 両方）", async () => {
    const a = await createSignal("needle in the haystack");
    const b = await createSignal("other text", "needle-entity");
    await createSignal("nothing relevant");

    const ids = await searchRawSignalIds("needle", db);
    expect(ids.sort()).toEqual([a.id, b.id].sort());
  });

  it("UPDATE がトリガで反映される（旧テキストは外れ新テキストに当たる）", async () => {
    const s = await createSignal("alpha keyword");
    expect(await searchRawSignalIds("alpha", db)).toEqual([s.id]);

    await db.rawSignal.update({ where: { id: s.id }, data: { rawText: "bravo keyword" } });
    expect(await searchRawSignalIds("alpha", db)).toEqual([]);
    expect(await searchRawSignalIds("bravo", db)).toEqual([s.id]);
  });

  it("DELETE がトリガで反映される", async () => {
    const s = await createSignal("charlie keyword");
    expect(await searchRawSignalIds("charlie", db)).toEqual([s.id]);
    await db.rawSignal.delete({ where: { id: s.id } });
    expect(await searchRawSignalIds("charlie", db)).toEqual([]);
  });

  it("空クエリは空配列（検索しない）", async () => {
    await createSignal("something");
    expect(await searchRawSignalIds("   ", db)).toEqual([]);
  });
});

describe("日本語検索（trigram 部分一致）", () => {
  it("語境界の無い日本語でも部分一致で引ける", async () => {
    const hit = await createSignal("日本語の全文検索テストを実施", "テスト株式会社");
    await createSignal("無関係な観測データ");

    expect(await searchRawSignalIds("全文検索", db)).toEqual([hit.id]);
    // observedEntity 側の部分一致。
    expect(await searchRawSignalIds("株式会社", db)).toEqual([hit.id]);
  });
});

describe("reindexAll（既存行の再インデックス）", () => {
  it("索引が欠落した既存行を再インデックスで復旧できる", async () => {
    const a = await createSignal("reindex target one");
    const b = await createSignal("reindex target two");

    // 索引だけを空にして「未索引の既存行」を再現する（トリガを介さず FTS を直接掃除）。
    await db.$executeRawUnsafe(`DELETE FROM "${RAW_SIGNAL_FTS_TABLE}"`);
    expect(await searchRawSignalIds("reindex", db)).toEqual([]);

    await reindexAll(db);
    const ids = await searchRawSignalIds("reindex", db);
    expect(ids.sort()).toEqual([a.id, b.id].sort());
  });
});

describe("search（id → 本体取得）と rawSignalRepo.list 連携", () => {
  it("search は RawSignal 本体を返す", async () => {
    const s = await createSignal("delta keyword observation");
    const rows = await search("delta", db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(s.id);
  });

  it("rawSignalRepo.list の q が FTS 経由で絞り込む（status と併用）", async () => {
    await db.rawSignal.create({
      data: { displayId: "RS-LST-1", sourceType: "review", rawText: "match me", status: "inbox" },
    });
    await db.rawSignal.create({
      data: {
        displayId: "RS-LST-2",
        sourceType: "review",
        rawText: "match me",
        status: "archived",
      },
    });
    await db.rawSignal.create({
      data: { displayId: "RS-LST-3", sourceType: "review", rawText: "unrelated", status: "inbox" },
    });

    const all = await rawSignalRepo.list({ q: "match me" }, db);
    expect(all).toHaveLength(2);

    const archived = await rawSignalRepo.list({ q: "match me", status: "archived" }, db);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.status).toBe("archived");
  });
});
