import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { decisionLogRepo } from "../../lib/db/decisionLogRepo";

// task-30 Scoring API v2（spec v2 §8.4-8.7 / §15.2 / §15.3）の受け入れ基準を網羅する。
// - POST /api/scoring/detailed/[candidateId]: 詳細スコア計算・保存・snapshot 自動記録・Top30 可否
// - POST /api/candidates/[id]/promote: stage 1段昇格＋DecisionLog（Top30 ゲート未達は昇格不可）
// - POST /api/candidates/[id]/merge, /split: task-29 の意味論を結線（throw → 4xx 翻訳）
// - GET /api/candidates/top30: Top30 ゲート通過候補のみ
// - GET /api/scoring/snapshots/[candidateId]: スコア推移履歴
//
// candidatePromote.test.ts と同方式で、本物の route → repository → DB 経路を検証する。
// 専用 SQLite に DATABASE_URL を向けてから client / handler を動的 import する。dev.db は触らない。

let dbDir: string;
let prisma: PrismaClient;
let candidatesRoute: typeof import("../../app/api/candidates/route");
let promoteRoute: typeof import("../../app/api/candidates/[id]/promote/route");
let mergeRoute: typeof import("../../app/api/candidates/[id]/merge/route");
let splitRoute: typeof import("../../app/api/candidates/[id]/split/route");
let top30Route: typeof import("../../app/api/candidates/top30/route");
let detailedRoute: typeof import("../../app/api/scoring/detailed/[candidateId]/route");
let snapshotsRoute: typeof import("../../app/api/scoring/snapshots/[candidateId]/route");
let scoringInitialRoute: typeof import("../../app/api/scoring/initial/[candidateId]/route");

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-scoring-v2-"));
  const url = `file:${join(dbDir, "test.db")}`;
  process.env.DATABASE_URL = url;
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  ({ prisma } = await import("../../lib/db/client"));
  candidatesRoute = await import("../../app/api/candidates/route");
  promoteRoute = await import("../../app/api/candidates/[id]/promote/route");
  mergeRoute = await import("../../app/api/candidates/[id]/merge/route");
  splitRoute = await import("../../app/api/candidates/[id]/split/route");
  top30Route = await import("../../app/api/candidates/top30/route");
  detailedRoute = await import("../../app/api/scoring/detailed/[candidateId]/route");
  snapshotsRoute = await import("../../app/api/scoring/snapshots/[candidateId]/route");
  scoringInitialRoute = await import("../../app/api/scoring/initial/[candidateId]/route");
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.evidence.deleteMany();
  await prisma.scoreSnapshot.deleteMany();
  await prisma.decisionLog.deleteMany();
  await prisma.candidate.deleteMany();
  await prisma.rawSignal.deleteMany();
});

let seq = 0;

type CandidateData = { id: string; displayId: string; stage: string };

function idCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}
function candidateIdCtx(candidateId: string): { params: Promise<{ candidateId: string }> } {
  return { params: Promise.resolve({ candidateId }) };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createCandidate(overrides: Record<string, unknown> = {}): Promise<CandidateData> {
  const res = await candidatesRoute.POST(
    jsonRequest("http://localhost/api/candidates", { title: "スコア v2 テスト候補", ...overrides }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: CandidateData }).data;
}

async function makeRawSignal(sourceType: string): Promise<{ id: string }> {
  seq += 1;
  return prisma.rawSignal.create({
    data: { displayId: `RS-V2-${seq}`, sourceType, rawText: "観測事実" },
  });
}

async function linkEvidence(
  candidateId: string,
  rawSignalId: string,
  evidenceType: string,
  strength: number,
): Promise<{ id: string }> {
  return prisma.evidence.create({
    data: { candidateId, rawSignalId, evidenceType, strength, credibility: 3 },
  });
}

/** 3 つの distinct source（Top30 の minDistinctSources=3）＋強シグナル（spend 含む）を付与する。 */
async function seedTop30Evidence(candidateId: string): Promise<void> {
  const rs1 = await makeRawSignal("app_store");
  const rs2 = await makeRawSignal("review");
  const rs3 = await makeRawSignal("sns");
  await linkEvidence(candidateId, rs1.id, "spend", 5);
  await linkEvidence(candidateId, rs2.id, "dissatisfaction", 5);
  await linkEvidence(candidateId, rs3.id, "search", 5);
}

// Top100 ゲート通過の初期素点（candidatePromote.test.ts と同等の強入力）。
const STRONG_INITIAL = {
  spend: 5,
  dissatisfaction: 5,
  pain: 5,
  frequency: 5,
  discoverability: 5,
  substitute: 5,
  legalRisk: 1,
  opsRisk: 1,
};

// 詳細スコア12軸（§8.4）。全軸満点 → DetailedScore=100（重み合計）。
const STRONG_DETAILED = {
  spend: 5,
  wtp: 5,
  acquisition: 5,
  pain: 5,
  frequency: 5,
  retention: 5,
  competitorPain: 5,
  differentiation: 5,
  formFit: 5,
  pfFit: 5,
  buildEase: 5,
  legalSafety: 5,
  uncertaintyLevel: "enough",
};

// 全軸0＋不確実性最大 → DetailedScore=0・ペナルティ-10（Top30 ゲート未達）。
const WEAK_DETAILED = {
  spend: 0,
  wtp: 0,
  acquisition: 0,
  pain: 0,
  frequency: 0,
  retention: 0,
  competitorPain: 0,
  differentiation: 0,
  formFit: 0,
  pfFit: 0,
  buildEase: 0,
  legalSafety: 0,
  uncertaintyLevel: "unconfirmed",
};

async function scoreInitial(candidateId: string, inputs: unknown): Promise<void> {
  const res = await scoringInitialRoute.POST(
    jsonRequest("http://localhost/api/scoring/initial/x", inputs),
    candidateIdCtx(candidateId),
  );
  expect(res.status).toBe(200);
}

async function scoreDetailed(candidateId: string, inputs: unknown): Promise<Response> {
  return detailedRoute.POST(
    jsonRequest("http://localhost/api/scoring/detailed/x", inputs),
    candidateIdCtx(candidateId),
  );
}

function promoteRequest(reason?: string): Request {
  return jsonRequest("http://localhost/api/candidates/x/promote", reason ? { reason } : {});
}

// ---------------------------------------------------------------------------
// POST /api/scoring/detailed/[candidateId]
// ---------------------------------------------------------------------------

describe("POST /api/scoring/detailed/[candidateId]", () => {
  it("computes / saves / snapshots and returns a passing Top30 gate", async () => {
    const cnd = await createCandidate({ testableWithinDays: 5 });
    await seedTop30Evidence(cnd.id);

    const res = await scoreDetailed(cnd.id, STRONG_DETAILED);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        candidate: { detailedScore: number | null };
        detailedScore: number;
        signalBonus: number;
        uncertaintyPenalty: number;
        totalForGate: number;
        confidence: number;
        gate: { pass: boolean; reasons: string[] };
      };
    };
    // 全軸満点 → DetailedScore=重み合計100、3 distinct source → SignalBonus=+10、enough → ペナルティ0。
    expect(data.detailedScore).toBe(100);
    expect(data.signalBonus).toBe(10);
    expect(data.uncertaintyPenalty).toBe(0);
    expect(data.totalForGate).toBe(110);
    expect(data.confidence).toBeGreaterThanOrEqual(0.7);
    expect(data.gate.pass).toBe(true);

    // 保存されている（detailedScore がキャッシュ列に永続化）。
    const reread = await prisma.candidate.findUnique({ where: { id: cnd.id } });
    expect(reread?.detailedScore).toBe(100);

    // snapshot が自動記録されている（task-28）。
    const snaps = await prisma.scoreSnapshot.findMany({ where: { candidateId: cnd.id } });
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(snaps.some((s) => s.detailedScore === 100)).toBe(true);
  });

  it("returns gate.pass=false with reasons when verification is undefined (testableWithinDays null)", async () => {
    // testableWithinDays 未設定 → 高スコアでも検証可能性ゲートで不合格（§8.7）。
    const cnd = await createCandidate();
    await seedTop30Evidence(cnd.id);

    const res = await scoreDetailed(cnd.id, STRONG_DETAILED);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { gate: { pass: boolean; reasons: string[] } } };
    expect(data.gate.pass).toBe(false);
    expect(data.gate.reasons.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 400 for invalid detailed inputs (out of range)", async () => {
    const cnd = await createCandidate({ testableWithinDays: 5 });
    const res = await scoreDetailed(cnd.id, { ...STRONG_DETAILED, spend: 9 });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a missing candidate", async () => {
    const res = await scoreDetailed("does-not-exist", STRONG_DETAILED);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/candidates/[id]/promote
// ---------------------------------------------------------------------------

describe("POST /api/candidates/[id]/promote", () => {
  it("promotes top100→top30 and records a DecisionLog when the Top30 gate passes", async () => {
    const cnd = await createCandidate({ testableWithinDays: 5 });
    await seedTop30Evidence(cnd.id);
    await scoreInitial(cnd.id, STRONG_INITIAL);

    // normalized → top100。
    const p1 = await promoteRoute.POST(promoteRequest("初期ゲート通過"), idCtx(cnd.id));
    expect(p1.status).toBe(200);
    expect(((await p1.json()) as { data: CandidateData }).data.stage).toBe("top100");

    // 詳細採点（Top30 ゲート通過の前提）。
    const d = await scoreDetailed(cnd.id, STRONG_DETAILED);
    expect(d.status).toBe(200);

    // top100 → top30（人間トリガ＋ DecisionLog）。
    const p2 = await promoteRoute.POST(promoteRequest("詳細ゲート通過のため昇格"), idCtx(cnd.id));
    expect(p2.status).toBe(200);
    expect(((await p2.json()) as { data: CandidateData }).data.stage).toBe("top30");

    const reread = await prisma.candidate.findUnique({ where: { id: cnd.id } });
    expect(reread?.stage).toBe("top30");

    // DecisionLog(promote) が 2 件刻まれている（normalized→top100, top100→top30）。
    const logs = await decisionLogRepo.listByCandidate(cnd.id, prisma);
    const promotes = logs.filter((l) => l.decisionType === "promote");
    expect(promotes.length).toBe(2);
    // 新しい順（最新が先頭）。直近は top100→top30。
    expect(promotes[0]!.fromStage).toBe("top100");
    expect(promotes[0]!.toStage).toBe("top30");
    expect(promotes[0]!.reason).toBe("詳細ゲート通過のため昇格");
  });

  it("blocks top100→top30 (422) when not detailed-scored yet", async () => {
    const cnd = await createCandidate({ testableWithinDays: 5 });
    await seedTop30Evidence(cnd.id);
    await scoreInitial(cnd.id, STRONG_INITIAL);
    const p1 = await promoteRoute.POST(promoteRequest(), idCtx(cnd.id));
    expect(p1.status).toBe(200); // top100

    // 詳細未採点 → Top30 ゲート判定不能 → 昇格不可。
    const p2 = await promoteRoute.POST(promoteRequest(), idCtx(cnd.id));
    expect(p2.status).toBe(422);
    const reread = await prisma.candidate.findUnique({ where: { id: cnd.id } });
    expect(reread?.stage).toBe("top100");
  });

  it("blocks top100→top30 (422) when the Top30 gate fails (weak detailed score)", async () => {
    const cnd = await createCandidate({ testableWithinDays: 5 });
    await seedTop30Evidence(cnd.id);
    await scoreInitial(cnd.id, STRONG_INITIAL);
    await promoteRoute.POST(promoteRequest(), idCtx(cnd.id)); // top100
    await scoreDetailed(cnd.id, WEAK_DETAILED); // detailedScore=0 → total<68

    const p2 = await promoteRoute.POST(promoteRequest(), idCtx(cnd.id));
    expect(p2.status).toBe(422);
    const json = (await p2.json()) as { error: { reasons?: string[] } };
    expect((json.error.reasons ?? []).length).toBeGreaterThanOrEqual(1);
    const reread = await prisma.candidate.findUnique({ where: { id: cnd.id } });
    expect(reread?.stage).toBe("top100");
  });

  it("returns 404 when promoting a missing id", async () => {
    const res = await promoteRoute.POST(promoteRequest(), idCtx("does-not-exist"));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/candidates/[id]/merge
// ---------------------------------------------------------------------------

describe("POST /api/candidates/[id]/merge", () => {
  it("merges the absorbed candidate into the survivor (re-parents evidence, archives absorbed)", async () => {
    const survivor = await createCandidate({ title: "生存側" });
    const absorbed = await createCandidate({ title: "吸収側" });
    const rs = await makeRawSignal("app_store");
    await linkEvidence(absorbed.id, rs.id, "spend", 4);

    const res = await mergeRoute.POST(
      jsonRequest("http://localhost/api/candidates/x/merge", {
        absorbedId: absorbed.id,
        reason: "重複候補の統合",
      }),
      idCtx(survivor.id),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { reparentedEvidence: number } };
    expect(data.reparentedEvidence).toBe(1);

    // 吸収側は archived、Evidence は生存側へ移送。
    const absorbedRow = await prisma.candidate.findUnique({ where: { id: absorbed.id } });
    expect(absorbedRow?.stage).toBe("archived");
    const survivorEvidence = await prisma.evidence.count({ where: { candidateId: survivor.id } });
    expect(survivorEvidence).toBe(1);
  });

  it("returns 400 when survivor === absorbed", async () => {
    const cnd = await createCandidate();
    const res = await mergeRoute.POST(
      jsonRequest("http://localhost/api/candidates/x/merge", { absorbedId: cnd.id, reason: "x" }),
      idCtx(cnd.id),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when the absorbed candidate is missing", async () => {
    const survivor = await createCandidate();
    const res = await mergeRoute.POST(
      jsonRequest("http://localhost/api/candidates/x/merge", {
        absorbedId: "does-not-exist",
        reason: "x",
      }),
      idCtx(survivor.id),
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when re-merging an already archived candidate", async () => {
    const survivor = await createCandidate();
    const absorbed = await createCandidate();
    const first = await mergeRoute.POST(
      jsonRequest("http://localhost/api/candidates/x/merge", {
        absorbedId: absorbed.id,
        reason: "1回目",
      }),
      idCtx(survivor.id),
    );
    expect(first.status).toBe(200);
    // 吸収側は archived。再統合は 409。
    const second = await mergeRoute.POST(
      jsonRequest("http://localhost/api/candidates/x/merge", {
        absorbedId: absorbed.id,
        reason: "2回目",
      }),
      idCtx(survivor.id),
    );
    expect(second.status).toBe(409);
  });

  it("returns 400 when reason is blank", async () => {
    const survivor = await createCandidate();
    const absorbed = await createCandidate();
    const res = await mergeRoute.POST(
      jsonRequest("http://localhost/api/candidates/x/merge", {
        absorbedId: absorbed.id,
        reason: "   ",
      }),
      idCtx(survivor.id),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/candidates/[id]/split
// ---------------------------------------------------------------------------

describe("POST /api/candidates/[id]/split", () => {
  it("splits a candidate, moving the chosen evidence to a new candidate", async () => {
    const source = await createCandidate({ title: "分割元" });
    const rs1 = await makeRawSignal("app_store");
    const rs2 = await makeRawSignal("review");
    const ev1 = await linkEvidence(source.id, rs1.id, "spend", 4);
    await linkEvidence(source.id, rs2.id, "dissatisfaction", 4);

    const res = await splitRoute.POST(
      jsonRequest("http://localhost/api/candidates/x/split", {
        evidenceIds: [ev1.id],
        reason: "別問題として分割",
        title: "分割先",
      }),
      idCtx(source.id),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { newCandidateId: string; movedEvidence: number } };
    expect(data.movedEvidence).toBe(1);

    // 新候補に 1 件、元候補に 1 件残る。
    const newCount = await prisma.evidence.count({ where: { candidateId: data.newCandidateId } });
    const srcCount = await prisma.evidence.count({ where: { candidateId: source.id } });
    expect(newCount).toBe(1);
    expect(srcCount).toBe(1);

    // 元候補に split の DecisionLog が残る（relatedCandidateId=新ID）。
    const logs = await decisionLogRepo.listByCandidate(source.id, prisma);
    const split = logs.find((l) => l.decisionType === "split");
    expect(split?.relatedCandidateId).toBe(data.newCandidateId);
  });

  it("returns 404 when the source candidate is missing", async () => {
    const res = await splitRoute.POST(
      jsonRequest("http://localhost/api/candidates/x/split", {
        evidenceIds: [],
        reason: "x",
      }),
      idCtx("does-not-exist"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when reason is blank", async () => {
    const source = await createCandidate();
    const res = await splitRoute.POST(
      jsonRequest("http://localhost/api/candidates/x/split", { evidenceIds: [], reason: "" }),
      idCtx(source.id),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/candidates/top30
// ---------------------------------------------------------------------------

describe("GET /api/candidates/top30", () => {
  it("returns only candidates passing the Top30 gate", async () => {
    // 通過候補（強い詳細スコア＋検証可能）。
    const pass = await createCandidate({ title: "通過", testableWithinDays: 5 });
    await seedTop30Evidence(pass.id);
    await scoreDetailed(pass.id, STRONG_DETAILED);

    // 不通過候補（詳細採点だが検証手段未定義）。
    const fail = await createCandidate({ title: "不通過" });
    await seedTop30Evidence(fail.id);
    await scoreDetailed(fail.id, STRONG_DETAILED);

    // 未採点候補（detailedScore null → 除外）。
    await createCandidate({ title: "未採点", testableWithinDays: 5 });

    const res = await top30Route.GET();
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: CandidateData[] };
    const ids = data.map((c) => c.id);
    expect(ids).toContain(pass.id);
    expect(ids).not.toContain(fail.id);
    expect(data.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/scoring/snapshots/[candidateId]
// ---------------------------------------------------------------------------

describe("GET /api/scoring/snapshots/[candidateId]", () => {
  it("returns the snapshot history (newest first) after scoring", async () => {
    const cnd = await createCandidate({ testableWithinDays: 5 });
    await seedTop30Evidence(cnd.id);
    await scoreInitial(cnd.id, STRONG_INITIAL); // snapshot 1
    await scoreDetailed(cnd.id, STRONG_DETAILED); // snapshot 2

    const res = await snapshotsRoute.GET(
      new Request("http://localhost/api/scoring/snapshots/x"),
      candidateIdCtx(cnd.id),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { detailedScore: number | null }[] };
    expect(data.length).toBeGreaterThanOrEqual(2);
    // 最新（先頭）は detailed 保存時の snapshot（detailedScore=100 を含む）。
    expect(data[0]!.detailedScore).toBe(100);
  });

  it("returns 404 for a missing candidate", async () => {
    const res = await snapshotsRoute.GET(
      new Request("http://localhost/api/scoring/snapshots/x"),
      candidateIdCtx("does-not-exist"),
    );
    expect(res.status).toBe(404);
  });
});
