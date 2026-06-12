import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { candidateMerge } from "../../lib/db/candidateMerge";
import { candidateRepo, type CandidateCreate } from "../../lib/db/candidateRepo";
import { decisionLogRepo } from "../../lib/db/decisionLogRepo";
import { evidenceRepo } from "../../lib/db/evidenceRepo";
import { snapshotRepo } from "../../lib/db/snapshotRepo";

// task-29 acceptance criteria (spec v2 §15.2):
// - merge で Evidence/Snapshot/Log が生存側へ移り、吸収側が archived、両者に merge ログ
// - merge 時の Evidence @@unique 衝突が安全に解決される（片方を残す）
// - split で新候補生成＋指定 Evidence 移動＋split ログ（relatedCandidateId=新ID）
//
// 専用の SQLite ファイルへ向けた PrismaClient を repository に注入し、各テスト前に
// 全テーブルをリセットして決定論性を担保する（dev.db は触らない）。

let dbDir: string;
let db: PrismaClient;

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-merge-"));
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

function candidateFixture(overrides: Partial<CandidateCreate> = {}): CandidateCreate {
  return {
    title: "テスト候補",
    ...overrides,
  } as CandidateCreate;
}

// 一次ソース（RawSignal）を直接作る（evidenceRepo.test の流儀。displayId を手で採番して
// rawSignalRepo.create の入力スキーマ型の取り回しを避ける）。
let rawSeq = 0;

/** 一次ソース（RawSignal）を 1 件作って id を返す。 */
async function makeRawSignal(rawText: string): Promise<string> {
  rawSeq += 1;
  const rs = await db.rawSignal.create({
    data: {
      displayId: `RS-20260613-${String(rawSeq).padStart(3, "0")}`,
      sourceType: "review",
      rawText,
    },
  });
  return rs.id;
}

/** Evidence を 1 件 link して id を返す。 */
async function linkEvidence(
  candidateId: string,
  rawSignalId: string,
  evidenceType: "spend" | "dissatisfaction" | "search",
): Promise<string> {
  const ev = await evidenceRepo.link(
    { candidateId, rawSignalId, evidenceType, strength: 3 },
    db,
  );
  return ev.id;
}

describe("candidateMerge.merge", () => {
  it("re-parents Evidence/Snapshot/Log to survivor, archives absorbed, logs both sides", async () => {
    const survivor = await candidateRepo.create(candidateFixture({ title: "生存側" }), db);
    const absorbed = await candidateRepo.create(candidateFixture({ title: "吸収側" }), db);

    // 吸収側に Evidence 2 件 / Snapshot 1 件 / 既存 DecisionLog 1 件を付ける。
    const rs1 = await makeRawSignal("吸収側シグナル1");
    const rs2 = await makeRawSignal("吸収側シグナル2");
    await linkEvidence(absorbed.id, rs1, "spend");
    await linkEvidence(absorbed.id, rs2, "dissatisfaction");
    await snapshotRepo.record({ candidateId: absorbed.id, detailedScore: 42 }, db);
    const priorLog = await decisionLogRepo.log(
      { candidateId: absorbed.id, decisionType: "promote", reason: "統合前の昇格判断" },
      db,
    );

    const result = await candidateMerge.merge(
      { survivorId: survivor.id, absorbedId: absorbed.id, reason: "重複候補を統合" },
      db,
    );

    expect(result.reparentedEvidence).toBe(2);
    expect(result.droppedEvidence).toBe(0);
    expect(result.reparentedSnapshots).toBe(1);
    expect(result.reparentedLogs).toBe(1);

    // Evidence は生存側へ移り、吸収側は空。
    expect(await evidenceRepo.listByCandidate(survivor.id, db)).toHaveLength(2);
    expect(await evidenceRepo.listByCandidate(absorbed.id, db)).toHaveLength(0);

    // Snapshot も生存側へ。
    expect(await snapshotRepo.listByCandidate(survivor.id, db)).toHaveLength(1);
    expect(await snapshotRepo.listByCandidate(absorbed.id, db)).toHaveLength(0);

    // 吸収側は archived。
    const absorbedAfter = await candidateRepo.getById(absorbed.id, db);
    expect(absorbedAfter!.stage).toBe("archived");

    // 生存側ログ: 既存の昇格ログ（再親付け済み）＋ merge ログ（related=吸収側）。
    const survivorLogs = await decisionLogRepo.listByCandidate(survivor.id, db);
    expect(survivorLogs.map((l) => l.id)).toContain(priorLog.id);
    const survivorMerge = survivorLogs.find((l) => l.decisionType === "merge");
    expect(survivorMerge).toBeDefined();
    expect(survivorMerge!.relatedCandidateId).toBe(absorbed.id);

    // 吸収側ログ: merge ログ 1 件のみ（related=生存側・toStage=archived）。
    const absorbedLogs = await decisionLogRepo.listByCandidate(absorbed.id, db);
    expect(absorbedLogs).toHaveLength(1);
    expect(absorbedLogs[0]!.decisionType).toBe("merge");
    expect(absorbedLogs[0]!.relatedCandidateId).toBe(survivor.id);
    expect(absorbedLogs[0]!.toStage).toBe("archived");
  });

  it("resolves Evidence @@unique collisions by keeping the survivor's row", async () => {
    const survivor = await candidateRepo.create(candidateFixture({ title: "生存側" }), db);
    const absorbed = await candidateRepo.create(candidateFixture({ title: "吸収側" }), db);

    // 同一 (rawSignal, evidenceType) を両者が持つ → 衝突。吸収側固有の証拠も 1 件用意。
    const shared = await makeRawSignal("共有シグナル");
    const onlyAbsorbed = await makeRawSignal("吸収側固有シグナル");
    await linkEvidence(survivor.id, shared, "spend");
    await linkEvidence(absorbed.id, shared, "spend"); // 生存側と衝突する
    await linkEvidence(absorbed.id, onlyAbsorbed, "search"); // 衝突しない

    const result = await candidateMerge.merge(
      { survivorId: survivor.id, absorbedId: absorbed.id, reason: "衝突ありの統合" },
      db,
    );

    // 衝突した 1 件は破棄、固有の 1 件は移送。例外は出ない。
    expect(result.droppedEvidence).toBe(1);
    expect(result.reparentedEvidence).toBe(1);

    // 生存側は「元の spend」＋「移送された search」= 2 件。吸収側は空。
    const survivorEvidence = await evidenceRepo.listByCandidate(survivor.id, db);
    expect(survivorEvidence).toHaveLength(2);
    expect(await evidenceRepo.listByCandidate(absorbed.id, db)).toHaveLength(0);

    // unique 制約（candidateId, rawSignalId, evidenceType）が壊れていない＝ spend は 1 件のみ。
    const spendForShared = survivorEvidence.filter(
      (e) => e.rawSignalId === shared && e.evidenceType === "spend",
    );
    expect(spendForShared).toHaveLength(1);
  });

  it("keeps the absorbed candidate's own merge log on chained merges (does not re-parent merge logs)", async () => {
    // 連鎖統合の回帰テスト（Codex 指摘）。まず C を B へ統合（B 生存）、続いて B を A へ
    // 統合する。B が「C を吸収した」merge ログは B 固有の履歴であり、B→A merge で A へ
    // 再親付けされてはならない（さもないと「A が C を吸収した」と誤って読めてしまう）。
    const a = await candidateRepo.create(candidateFixture({ title: "A" }), db);
    const b = await candidateRepo.create(candidateFixture({ title: "B" }), db);
    const c = await candidateRepo.create(candidateFixture({ title: "C" }), db);

    // 1回目: C を B へ統合。B に merge ログ(related=C) が刻まれる。
    await candidateMerge.merge({ survivorId: b.id, absorbedId: c.id, reason: "C を B へ統合" }, db);
    const bMergeWithC = (await decisionLogRepo.listByCandidate(b.id, db)).filter(
      (l) => l.decisionType === "merge" && l.relatedCandidateId === c.id,
    );
    expect(bMergeWithC).toHaveLength(1);

    // 2回目: B を A へ統合。
    await candidateMerge.merge({ survivorId: a.id, absorbedId: b.id, reason: "B を A へ統合" }, db);

    // A の merge ログは今回の統合(related=B)のみ。過去の B↔C 統合(related=C)は紛れ込まない。
    const aMergeRelated = (await decisionLogRepo.listByCandidate(a.id, db))
      .filter((l) => l.decisionType === "merge")
      .map((l) => l.relatedCandidateId);
    expect(aMergeRelated).toContain(b.id);
    expect(aMergeRelated).not.toContain(c.id);

    // B が C を吸収した履歴は B に残る（再親付けされない）。
    const bMergeWithCAfter = (await decisionLogRepo.listByCandidate(b.id, db)).filter(
      (l) => l.decisionType === "merge" && l.relatedCandidateId === c.id,
    );
    expect(bMergeWithCAfter).toHaveLength(1);
  });
});

describe("candidateMerge.split", () => {
  it("creates a duplicate candidate, moves the given Evidence, and logs the split", async () => {
    const source = await candidateRepo.create(
      candidateFixture({ title: "元候補", painStatement: "元の課題" }),
      db,
    );
    const rs1 = await makeRawSignal("シグナル1");
    const rs2 = await makeRawSignal("シグナル2");
    const rs3 = await makeRawSignal("シグナル3");
    const e1 = await linkEvidence(source.id, rs1, "spend");
    const e2 = await linkEvidence(source.id, rs2, "dissatisfaction");
    await linkEvidence(source.id, rs3, "search"); // 元候補に残す

    const result = await candidateMerge.split(
      { sourceId: source.id, evidenceIds: [e1, e2], reason: "別問題として分割", title: "新候補" },
      db,
    );

    expect(result.movedEvidence).toBe(2);

    // 新候補が生成され、複製のフィールドを継承（タイトルは上書き）。
    const created = await candidateRepo.getById(result.newCandidateId, db);
    expect(created).not.toBeNull();
    expect(created!.id).not.toBe(source.id);
    expect(created!.title).toBe("新候補");
    expect(created!.painStatement).toBe("元の課題");

    // 指定 Evidence は新候補へ、残りは元候補に。
    const sourceEvidence = await evidenceRepo.listByCandidate(source.id, db);
    const newEvidence = await evidenceRepo.listByCandidate(result.newCandidateId, db);
    expect(sourceEvidence).toHaveLength(1);
    expect(sourceEvidence[0]!.rawSignalId).toBe(rs3);
    expect(newEvidence.map((e) => e.id).sort()).toEqual([e1, e2].sort());

    // 元候補に split ログ（related=新ID）。
    const sourceLogs = await decisionLogRepo.listByCandidate(source.id, db);
    expect(sourceLogs).toHaveLength(1);
    expect(sourceLogs[0]!.decisionType).toBe("split");
    expect(sourceLogs[0]!.relatedCandidateId).toBe(result.newCandidateId);

    // 新候補は別 displayId を採番している。
    const sourceRow = await candidateRepo.getById(source.id, db);
    expect(created!.displayId).not.toBe(sourceRow!.displayId);
  });

  it("inherits the source title when no override is given and moves no Evidence when none specified", async () => {
    const source = await candidateRepo.create(candidateFixture({ title: "継承元" }), db);

    const result = await candidateMerge.split(
      { sourceId: source.id, evidenceIds: [], reason: "空分割" },
      db,
    );

    expect(result.movedEvidence).toBe(0);
    const created = await candidateRepo.getById(result.newCandidateId, db);
    expect(created!.title).toBe("継承元");
  });
});
