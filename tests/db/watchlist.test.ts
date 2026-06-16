import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { candidateRepo, type CandidateCreate } from "../../lib/db/candidateRepo";
import { computeDeltaFlag, watchlistRepo } from "../../lib/db/watchlistRepo";
import { watchlistEntityTypeSchema } from "../../lib/validation/enums";
import { type WatchlistInput } from "../../lib/validation/schemas";

// task-36 acceptance criteria（spec v2 §9.8 / フィールドは §7.7）:
// - CRUD と updateValue（current→last シフト＋差分算出）
// - deltaFlag が up/down/unchanged を正しく判定（unknown も含む）
// - linkedCandidateId で候補に紐付く
//
// 専用の SQLite ファイルへ向けた PrismaClient を repository に注入し、各テスト前に全テーブルを
// リセットして決定論性を担保する（dev.db は触らない）。import は相対パス（@/ は vitest 非対応）。

let dbDir: string;
let db: PrismaClient;

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-watchlist-"));
  const url = `file:${join(dbDir, "test.db")}`;
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
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
  await db.watchlist.deleteMany();
  await db.evidence.deleteMany();
  await db.scoreSnapshot.deleteMany();
  await db.decisionLog.deleteMany();
  await db.candidate.deleteMany();
  await db.rawSignal.deleteMany();
});

function wlFixture(overrides: Partial<WatchlistInput> = {}): WatchlistInput {
  return {
    entityType: watchlistEntityTypeSchema.enum.competitor_app,
    entityName: "Acme 請求書アプリ",
    metricName: "ランキング",
    ...overrides,
  } as WatchlistInput;
}

async function createCandidate(): Promise<{ id: string }> {
  return candidateRepo.create({ title: "紐付け候補" } as CandidateCreate, db);
}

describe("computeDeltaFlag（純関数・数値比較で差分方向）", () => {
  it("数値が増加なら up / 減少なら down / 同値なら unchanged", () => {
    expect(computeDeltaFlag("3", "5")).toBe("up");
    expect(computeDeltaFlag("5", "3")).toBe("down");
    expect(computeDeltaFlag("5", "5")).toBe("unchanged");
    expect(computeDeltaFlag("4.5", "4.50")).toBe("unchanged");
  });

  it("初回（前回値なし）/ 欠落 / 数値化できない値は unknown", () => {
    expect(computeDeltaFlag(null, "5")).toBe("unknown");
    expect(computeDeltaFlag("5", null)).toBe("unknown");
    expect(computeDeltaFlag("", "5")).toBe("unknown");
    expect(computeDeltaFlag("1位", "2位")).toBe("unknown");
    expect(computeDeltaFlag("5", "たくさん")).toBe("unknown");
  });
});

describe("watchlistRepo CRUD", () => {
  it("create → getById で永続化を確認（deltaFlag 既定は unknown）", async () => {
    const created = await watchlistRepo.create(wlFixture({ currentValue: "10" }), db);
    expect(created.entityName).toBe("Acme 請求書アプリ");
    expect(created.deltaFlag).toBe("unknown");

    const fetched = await watchlistRepo.getById(created.id, db);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.currentValue).toBe("10");
  });

  it("不正な entityType は作成時に弾く（Zod）", async () => {
    await expect(
      watchlistRepo.create(wlFixture({ entityType: "bogus" as never }), db),
    ).rejects.toThrow();
  });

  it("update は省略フィールドを上書きしない（部分更新）", async () => {
    const created = await watchlistRepo.create(wlFixture({ note: "初期メモ", currentValue: "10" }), db);
    const updated = await watchlistRepo.update(created.id, { note: "更新メモ" }, db);
    expect(updated.note).toBe("更新メモ");
    // 触れていない currentValue / deltaFlag / entityName は保持される。
    expect(updated.currentValue).toBe("10");
    expect(updated.entityName).toBe("Acme 請求書アプリ");
    expect(updated.deltaFlag).toBe("unknown");
  });

  it("delete で削除できる", async () => {
    const created = await watchlistRepo.create(wlFixture(), db);
    await watchlistRepo.delete(created.id, db);
    expect(await watchlistRepo.getById(created.id, db)).toBeNull();
  });

  it("list は entityType / linkedCandidateId で絞り込み・新しい順", async () => {
    const candidate = await createCandidate();
    const a = await watchlistRepo.create(
      wlFixture({ entityType: watchlistEntityTypeSchema.enum.competitor_app }),
      db,
    );
    const b = await watchlistRepo.create(
      wlFixture({
        entityType: watchlistEntityTypeSchema.enum.keyword,
        entityName: "請求書 自動化",
        linkedCandidateId: candidate.id,
      }),
      db,
    );

    const all = await watchlistRepo.list({}, db);
    expect(all.map((w) => w.id).sort()).toEqual([a.id, b.id].sort());

    const onlyKeyword = await watchlistRepo.list(
      { entityType: watchlistEntityTypeSchema.enum.keyword },
      db,
    );
    expect(onlyKeyword.map((w) => w.id)).toEqual([b.id]);

    const linked = await watchlistRepo.list({ linkedCandidateId: candidate.id }, db);
    expect(linked.map((w) => w.id)).toEqual([b.id]);
  });
});

describe("watchlistRepo.updateValue（current→last シフト＋差分算出）", () => {
  it("初回は前回値が無いので unknown・currentValue に新値が入る", async () => {
    const created = await watchlistRepo.create(wlFixture(), db);
    const after = await watchlistRepo.updateValue(created.id, "5", db);
    expect(after.lastValue).toBeNull();
    expect(after.currentValue).toBe("5");
    expect(after.deltaFlag).toBe("unknown");
    expect(after.lastCheckedAt).not.toBeNull();
  });

  it("2 回目以降は current→last へシフトし数値比較で up/down/unchanged を判定", async () => {
    const created = await watchlistRepo.create(wlFixture(), db);
    await watchlistRepo.updateValue(created.id, "5", db);

    const down = await watchlistRepo.updateValue(created.id, "3", db);
    expect(down.lastValue).toBe("5");
    expect(down.currentValue).toBe("3");
    expect(down.deltaFlag).toBe("down");

    const up = await watchlistRepo.updateValue(created.id, "7", db);
    expect(up.lastValue).toBe("3");
    expect(up.deltaFlag).toBe("up");

    const same = await watchlistRepo.updateValue(created.id, "7", db);
    expect(same.lastValue).toBe("7");
    expect(same.deltaFlag).toBe("unchanged");
  });

  it("数値化できない値同士は unknown（比較不能）", async () => {
    const created = await watchlistRepo.create(wlFixture({ currentValue: "1位" }), db);
    const after = await watchlistRepo.updateValue(created.id, "2位", db);
    expect(after.lastValue).toBe("1位");
    expect(after.currentValue).toBe("2位");
    expect(after.deltaFlag).toBe("unknown");
  });

  it("空の新値は弾く（Zod）", async () => {
    const created = await watchlistRepo.create(wlFixture(), db);
    await expect(watchlistRepo.updateValue(created.id, "", db)).rejects.toThrow();
  });
});

describe("linkedCandidateId による候補紐付け", () => {
  it("候補に紐付けて作成・取得できる", async () => {
    const candidate = await createCandidate();
    const created = await watchlistRepo.create(wlFixture({ linkedCandidateId: candidate.id }), db);
    expect(created.linkedCandidateId).toBe(candidate.id);

    const fetched = await watchlistRepo.getById(created.id, db);
    expect(fetched?.linkedCandidateId).toBe(candidate.id);
  });

  it("紐付き候補を削除すると linkedCandidateId は null になる（SetNull）", async () => {
    const candidate = await createCandidate();
    const created = await watchlistRepo.create(wlFixture({ linkedCandidateId: candidate.id }), db);

    // Candidate は repo に hard delete を持たない（ソフト退役方針）。SetNull の検証のため
    // テストでは prisma を直接使って物理削除する。
    await db.candidate.delete({ where: { id: candidate.id } });

    const fetched = await watchlistRepo.getById(created.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched?.linkedCandidateId).toBeNull();
  });
});
