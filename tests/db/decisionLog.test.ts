import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { candidateRepo, type CandidateCreate } from "../../lib/db/candidateRepo";
import { decisionLogRepo } from "../../lib/db/decisionLogRepo";

// task-29 acceptance criteria (spec v2 §7.6 / §15.3):
// - log の記録・取得（reason 必須・空文字は弾く）
// - decisionType / fromStage / toStage / relatedCandidateId を正しく刻む
// - listByCandidate は新しい順（decidedAt 降順・id tie-break）で候補スコープ
//
// 専用の SQLite ファイルへ向けた PrismaClient を repository に注入し、各テスト前に
// 全テーブルをリセットして決定論性を担保する（dev.db は触らない）。

let dbDir: string;
let db: PrismaClient;

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-decisionlog-"));
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

describe("decisionLogRepo.log / listByCandidate", () => {
  it("records a decision with the required reason and full fields", async () => {
    const c = await candidateRepo.create(inputFixture(), db);

    const logged = await decisionLogRepo.log(
      {
        candidateId: c.id,
        decisionType: "promote",
        fromStage: "top100",
        toStage: "top30",
        reason: "支出シグナルが揃ったため昇格",
      },
      db,
    );

    expect(logged.decisionType).toBe("promote");
    expect(logged.fromStage).toBe("top100");
    expect(logged.toStage).toBe("top30");
    expect(logged.reason).toBe("支出シグナルが揃ったため昇格");
    expect(logged.relatedCandidateId).toBeNull();

    const list = await decisionLogRepo.listByCandidate(c.id, db);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(logged.id);
  });

  it("rejects an empty reason (reason is required, §15.3)", async () => {
    const c = await candidateRepo.create(inputFixture(), db);

    await expect(
      decisionLogRepo.log({ candidateId: c.id, decisionType: "hold", reason: "" }, db),
    ).rejects.toThrow();

    expect(await decisionLogRepo.listByCandidate(c.id, db)).toHaveLength(0);
  });

  it("records each decisionType including merge/split with relatedCandidateId", async () => {
    const a = await candidateRepo.create(inputFixture({ title: "A" }), db);
    const b = await candidateRepo.create(inputFixture({ title: "B" }), db);

    await decisionLogRepo.log(
      { candidateId: a.id, decisionType: "merge", relatedCandidateId: b.id, reason: "重複統合" },
      db,
    );
    await decisionLogRepo.log(
      { candidateId: a.id, decisionType: "split", relatedCandidateId: b.id, reason: "別問題に分割" },
      db,
    );

    const list = await decisionLogRepo.listByCandidate(a.id, db);
    const types = list.map((l) => l.decisionType);
    expect(types).toContain("merge");
    expect(types).toContain("split");
    for (const l of list) {
      expect(l.relatedCandidateId).toBe(b.id);
    }
  });

  it("lists newest-first by decidedAt (desc) and scopes by candidate", async () => {
    const a = await candidateRepo.create(inputFixture({ title: "A" }), db);
    const b = await candidateRepo.create(inputFixture({ title: "B" }), db);

    await decisionLogRepo.log(
      {
        candidateId: a.id,
        decisionType: "hold",
        reason: "古い判断",
        decidedAt: new Date("2026-06-01T00:00:00Z"),
      },
      db,
    );
    await decisionLogRepo.log(
      {
        candidateId: a.id,
        decisionType: "promote",
        reason: "新しい判断",
        decidedAt: new Date("2026-06-10T00:00:00Z"),
      },
      db,
    );
    // 別候補のログは混ざらない。
    await decisionLogRepo.log(
      { candidateId: b.id, decisionType: "reject", reason: "別候補の棄却" },
      db,
    );

    const list = await decisionLogRepo.listByCandidate(a.id, db);
    expect(list).toHaveLength(2);
    expect(list.map((l) => l.reason)).toEqual(["新しい判断", "古い判断"]);
  });

  it("breaks ties deterministically by id desc when decidedAt is equal", async () => {
    const c = await candidateRepo.create(inputFixture(), db);
    const at = new Date("2026-06-05T00:00:00Z");

    const first = await decisionLogRepo.log(
      { candidateId: c.id, decisionType: "hold", reason: "1件目", decidedAt: at },
      db,
    );
    const second = await decisionLogRepo.log(
      { candidateId: c.id, decisionType: "hold", reason: "2件目", decidedAt: at },
      db,
    );

    // 同一 decidedAt では id 降順（後に作られた cuid が大きい）＝後に作った行が先頭。
    const list = await decisionLogRepo.listByCandidate(c.id, db);
    expect(list.map((l) => l.id)).toEqual([second.id, first.id]);
  });
});
