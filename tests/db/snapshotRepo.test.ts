import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { candidateRepo, type CandidateCreate } from "../../lib/db/candidateRepo";
import {
  SAVE_SCORES_SNAPSHOT_REASON,
  snapshotRepo,
} from "../../lib/db/snapshotRepo";

// task-28 acceptance criteria (spec v2 §7.5 / §9.9):
// - saveScores 1 回で snapshot が 1 行増える（自動記録）
// - configVersion が snapshot に記録される
// - weekDelta が期間内の最初と最後の snapshot の増減を正しく返す
//
// 専用の SQLite ファイルへ向けた PrismaClient を repository に注入し、
// 各テスト前に全テーブルをリセットして決定論性を担保する（dev.db は触らない）。

let dbDir: string;
let db: PrismaClient;

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-snapshot-"));
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
  await db.evidence.deleteMany();
  await db.scoreSnapshot.deleteMany();
  await db.decisionLog.deleteMany();
  await db.candidate.deleteMany();
  await db.rawSignal.deleteMany();
});

function inputFixture(overrides: Partial<CandidateCreate> = {}): CandidateCreate {
  return {
    title: "テスト候補",
    ...overrides,
  } as CandidateCreate;
}

describe("candidateRepo.saveScores → ScoreSnapshot 自動記録", () => {
  it("records exactly one snapshot per saveScores call", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    expect(await snapshotRepo.listByCandidate(created.id, db)).toHaveLength(0);

    await candidateRepo.saveScores(
      created.id,
      { initialScore: 50, detailedScore: 60, confidence: 0.7 },
      db,
    );

    const snapshots = await snapshotRepo.listByCandidate(created.id, db);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.reason).toBe(SAVE_SCORES_SNAPSHOT_REASON);
  });

  it("adds one row on every save (history accumulates, not overwrites)", async () => {
    const created = await candidateRepo.create(inputFixture(), db);

    await candidateRepo.saveScores(created.id, { detailedScore: 60 }, db);
    await candidateRepo.saveScores(created.id, { detailedScore: 70 }, db);
    await candidateRepo.saveScores(created.id, { detailedScore: 80 }, db);

    expect(await snapshotRepo.listByCandidate(created.id, db)).toHaveLength(3);
  });

  it("snapshots the resulting full derived-score state (even on partial saves)", async () => {
    const created = await candidateRepo.create(inputFixture(), db);

    // 1 回目で detailedScore を入れ、2 回目は confidence だけ部分保存する。
    await candidateRepo.saveScores(created.id, { detailedScore: 70 }, db);
    await candidateRepo.saveScores(created.id, { confidence: 0.9 }, db);

    // 直近の snapshot は「更新後の Candidate 全体」を写すので detailedScore も残っている。
    const snapshots = await snapshotRepo.listByCandidate(created.id, db);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.confidence).toBe(0.9);
    expect(snapshots[0]!.detailedScore).toBe(70);
  });

  it("records the configVersion into the snapshot", async () => {
    const created = await candidateRepo.create(inputFixture(), db);

    await candidateRepo.saveScores(
      created.id,
      { detailedScore: 65, scoreConfigVersion: "2026.06-v1" },
      db,
    );

    const snapshots = await snapshotRepo.listByCandidate(created.id, db);
    expect(snapshots[0]!.configVersion).toBe("2026.06-v1");
  });

  it("carries the configVersion forward on a later partial save", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    await candidateRepo.saveScores(
      created.id,
      { detailedScore: 65, scoreConfigVersion: "2026.06-v1" },
      db,
    );
    // configVersion を渡さない後続保存でも、Candidate に保持された値が snapshot に写る。
    await candidateRepo.saveScores(created.id, { confidence: 0.8 }, db);

    const snapshots = await snapshotRepo.listByCandidate(created.id, db);
    expect(snapshots[0]!.configVersion).toBe("2026.06-v1");
  });
});

describe("snapshotRepo.record / listByCandidate", () => {
  it("records a standalone snapshot scoped to its candidate", async () => {
    const a = await candidateRepo.create(inputFixture({ title: "A" }), db);
    const b = await candidateRepo.create(inputFixture({ title: "B" }), db);

    await snapshotRepo.record({ candidateId: a.id, detailedScore: 10 }, db);
    await snapshotRepo.record({ candidateId: a.id, detailedScore: 20 }, db);
    await snapshotRepo.record({ candidateId: b.id, detailedScore: 99 }, db);

    expect(await snapshotRepo.listByCandidate(a.id, db)).toHaveLength(2);
    const bSnapshots = await snapshotRepo.listByCandidate(b.id, db);
    expect(bSnapshots).toHaveLength(1);
    expect(bSnapshots[0]!.detailedScore).toBe(99);
  });

  it("lists snapshots newest-first (snapshotAt desc)", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    await snapshotRepo.record(
      { candidateId: created.id, detailedScore: 10, snapshotAt: new Date("2026-06-01T00:00:00Z") },
      db,
    );
    await snapshotRepo.record(
      { candidateId: created.id, detailedScore: 30, snapshotAt: new Date("2026-06-08T00:00:00Z") },
      db,
    );

    const snapshots = await snapshotRepo.listByCandidate(created.id, db);
    expect(snapshots.map((s) => s.detailedScore)).toEqual([30, 10]);
  });

  it("stores omitted score fields as null", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    await snapshotRepo.record({ candidateId: created.id, detailedScore: 42 }, db);

    const [snapshot] = await snapshotRepo.listByCandidate(created.id, db);
    expect(snapshot!.detailedScore).toBe(42);
    expect(snapshot!.initialScore).toBeNull();
    expect(snapshot!.confidence).toBeNull();
    expect(snapshot!.configVersion).toBeNull();
  });
});

describe("snapshotRepo.weekDelta", () => {
  const SINCE = new Date("2026-06-06T00:00:00Z");

  it("returns the rise/fall between the first and last snapshot in the window", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    // 期間内に 3 件: detailedScore 50 → 60 → 75（上昇 +25）、confidence 0.6 → 0.5（低下 -0.1）。
    await snapshotRepo.record(
      {
        candidateId: created.id,
        detailedScore: 50,
        confidence: 0.6,
        snapshotAt: new Date("2026-06-07T00:00:00Z"),
      },
      db,
    );
    await snapshotRepo.record(
      {
        candidateId: created.id,
        detailedScore: 60,
        confidence: 0.55,
        snapshotAt: new Date("2026-06-09T00:00:00Z"),
      },
      db,
    );
    await snapshotRepo.record(
      {
        candidateId: created.id,
        detailedScore: 75,
        confidence: 0.5,
        snapshotAt: new Date("2026-06-12T00:00:00Z"),
      },
      db,
    );

    const result = await snapshotRepo.weekDelta(created.id, SINCE, db);
    expect(result.count).toBe(3);
    expect(result.first!.detailedScore).toBe(50);
    expect(result.last!.detailedScore).toBe(75);
    expect(result.delta.detailedScore).toBe(25);
    expect(result.delta.confidence).toBeCloseTo(-0.1, 10);
  });

  it("ignores snapshots older than `since`", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    // 期間外（古い）: 無視されるべき。
    await snapshotRepo.record(
      { candidateId: created.id, detailedScore: 5, snapshotAt: new Date("2026-05-01T00:00:00Z") },
      db,
    );
    // 期間内: これが first になる。
    await snapshotRepo.record(
      { candidateId: created.id, detailedScore: 40, snapshotAt: new Date("2026-06-07T00:00:00Z") },
      db,
    );
    await snapshotRepo.record(
      { candidateId: created.id, detailedScore: 70, snapshotAt: new Date("2026-06-10T00:00:00Z") },
      db,
    );

    const result = await snapshotRepo.weekDelta(created.id, SINCE, db);
    expect(result.count).toBe(2);
    expect(result.first!.detailedScore).toBe(40);
    expect(result.delta.detailedScore).toBe(30);
  });

  it("returns count 0 and null deltas when the window is empty", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    await snapshotRepo.record(
      { candidateId: created.id, detailedScore: 5, snapshotAt: new Date("2026-05-01T00:00:00Z") },
      db,
    );

    const result = await snapshotRepo.weekDelta(created.id, SINCE, db);
    expect(result.count).toBe(0);
    expect(result.first).toBeNull();
    expect(result.last).toBeNull();
    expect(result.delta.detailedScore).toBeNull();
  });

  it("yields zero delta when only one snapshot is in the window (first === last)", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    await snapshotRepo.record(
      { candidateId: created.id, detailedScore: 55, snapshotAt: new Date("2026-06-08T00:00:00Z") },
      db,
    );

    const result = await snapshotRepo.weekDelta(created.id, SINCE, db);
    expect(result.count).toBe(1);
    expect(result.first!.id).toBe(result.last!.id);
    expect(result.delta.detailedScore).toBe(0);
  });

  it("returns null delta for a field missing on either endpoint", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    // first は confidence を持つが、last は持たない（null）。差分は計算できない → null。
    await snapshotRepo.record(
      {
        candidateId: created.id,
        detailedScore: 50,
        confidence: 0.6,
        snapshotAt: new Date("2026-06-07T00:00:00Z"),
      },
      db,
    );
    await snapshotRepo.record(
      { candidateId: created.id, detailedScore: 80, snapshotAt: new Date("2026-06-10T00:00:00Z") },
      db,
    );

    const result = await snapshotRepo.weekDelta(created.id, SINCE, db);
    expect(result.delta.detailedScore).toBe(30);
    expect(result.delta.confidence).toBeNull();
  });
});
