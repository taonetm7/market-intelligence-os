import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// task-13 acceptance criteria (spec v2 §8 / §13):
// - Candidate の CRUD（作成/取得/一覧/更新/削除=ソフト退役）
// - reject（reasonCode 必須）。コード無しは 400
// - scoring/initial: 素点 → InitialScore/confidence を計算・保存（configVersion 残存）し、
//   Top100 ゲートの pass/reasons をレスポンスに含める
// - top100: ゲート通過候補のみ返す
//
// evidenceLink.api.test.ts と同方式で、本物の route → repository → DB 経路を検証する。
// 専用 SQLite に DATABASE_URL を向けてから client / handler を動的 import する。dev.db は触らない。

let dbDir: string;
let prisma: PrismaClient;
// scoringConfig（version / gate 閾値）も動的 import 後に読む。
let scoringConfig: typeof import("../../lib/scoring/config").scoringConfig;
// 動的 import した route handler 群（DATABASE_URL 設定後に読み込む）。
let candidatesRoute: typeof import("../../app/api/candidates/route");
let candidateIdRoute: typeof import("../../app/api/candidates/[id]/route");
let rejectRoute: typeof import("../../app/api/candidates/[id]/reject/route");
let scoringRoute: typeof import("../../app/api/scoring/initial/[candidateId]/route");
let top100Route: typeof import("../../app/api/candidates/top100/route");

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-candidate-api-"));
  const url = `file:${join(dbDir, "test.db")}`;
  process.env.DATABASE_URL = url;
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  // DATABASE_URL 設定後に読み込む（シングルトンがこの URL で構築される）。
  ({ prisma } = await import("../../lib/db/client"));
  ({ scoringConfig } = await import("../../lib/scoring/config"));
  candidatesRoute = await import("../../app/api/candidates/route");
  candidateIdRoute = await import("../../app/api/candidates/[id]/route");
  rejectRoute = await import("../../app/api/candidates/[id]/reject/route");
  scoringRoute = await import("../../app/api/scoring/initial/[candidateId]/route");
  top100Route = await import("../../app/api/candidates/top100/route");
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // FK 順に削除（Evidence → RawSignal / Candidate）。
  await prisma.evidence.deleteMany();
  await prisma.rawSignal.deleteMany();
  await prisma.candidate.deleteMany();
});

// ---------------------------------------------------------------------------
// fixtures / helpers
// ---------------------------------------------------------------------------

// displayId 衝突を避けるための単調増加カウンタ（beforeEach の削除をまたいで一意）。
let seq = 0;

function jsonRequest(method: string, body: unknown): Request {
  return new Request("http://localhost/api/candidates", {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** [id] route 用の context（params は Promise）。 */
function idCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

/** scoring/initial route 用の context（param キーは candidateId）。 */
function candidateIdCtx(candidateId: string): { params: Promise<{ candidateId: string }> } {
  return { params: Promise.resolve({ candidateId }) };
}

type CandidateData = {
  id: string;
  displayId: string;
  title: string;
  stage: string;
  initialScore: number | null;
  confidence: number | null;
  scoreConfigVersion: string | null;
  rejectedReasonCode: string | null;
};

/** POST /api/candidates で 1 件作成し、作成された候補（data）を返す。 */
async function createCandidate(body: Record<string, unknown> = { title: "テスト候補" }): Promise<CandidateData> {
  const res = await candidatesRoute.POST(jsonRequest("POST", body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: CandidateData }).data;
}

async function makeRawSignal(sourceType: string): Promise<{ id: string }> {
  seq += 1;
  return prisma.rawSignal.create({
    data: { displayId: `RS-CND-${seq}`, sourceType, rawText: "観測事実" },
  });
}

/** prisma で Evidence を直接 seed する（route 経由でない採点前提データ）。 */
async function linkEvidence(
  candidateId: string,
  rawSignalId: string,
  evidenceType: string,
  strength: number,
): Promise<void> {
  await prisma.evidence.create({
    data: { candidateId, rawSignalId, evidenceType, strength, credibility: 3 },
  });
}

/** ゲート通過に十分な素点（全軸 5・リスク低）。 */
const STRONG_INPUTS = {
  spend: 5,
  dissatisfaction: 5,
  pain: 5,
  frequency: 5,
  discoverability: 5,
  substitute: 5,
  legalRisk: 1,
  opsRisk: 1,
};

/** ゲート不通過の素点（全軸 0）。 */
const WEAK_INPUTS = {
  spend: 0,
  dissatisfaction: 0,
  pain: 0,
  frequency: 0,
  discoverability: 0,
  substitute: 0,
  legalRisk: 0,
  opsRisk: 0,
};

function scoringRequest(body: unknown): Request {
  return new Request("http://localhost/api/scoring/initial/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** candidate に 2 つの distinct source + 強シグナル（spend/dissatisfaction）を付与する。 */
async function seedStrongEvidence(candidateId: string): Promise<void> {
  const rs1 = await makeRawSignal("app_store");
  const rs2 = await makeRawSignal("review");
  await linkEvidence(candidateId, rs1.id, "spend", 4);
  await linkEvidence(candidateId, rs2.id, "dissatisfaction", 4);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe("Candidate CRUD", () => {
  it("creates a candidate and returns 201 with displayId and default stage", async () => {
    const res = await candidatesRoute.POST(jsonRequest("POST", { title: "新規候補" }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: CandidateData };
    expect(data.id).toBeTruthy();
    expect(data.displayId).toMatch(/^CND-/);
    expect(data.title).toBe("新規候補");
    expect(data.stage).toBe("normalized");
    expect(await prisma.candidate.count()).toBe(1);
  });

  it("returns 400 when creating without a title", async () => {
    const res = await candidatesRoute.POST(jsonRequest("POST", { targetUser: "誰か" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { issues?: unknown[] } };
    expect(Array.isArray(json.error.issues)).toBe(true);
    expect(await prisma.candidate.count()).toBe(0);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const res = await candidatesRoute.POST(jsonRequest("POST", "{ not json"));
    expect(res.status).toBe(400);
  });

  it("gets a candidate by id (200) and 404 for a missing id", async () => {
    const cnd = await createCandidate();
    const ok = await candidateIdRoute.GET(new Request("http://localhost/x"), idCtx(cnd.id));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: CandidateData }).data.id).toBe(cnd.id);

    const missing = await candidateIdRoute.GET(new Request("http://localhost/x"), idCtx("nope"));
    expect(missing.status).toBe(404);
  });

  it("lists candidates and filters by stage", async () => {
    const a = await createCandidate({ title: "候補A" });
    await createCandidate({ title: "候補B" });
    // a を top100 へ昇格させてから stage フィルタを確認する。stage 昇格は task-21 の専用 API
    // の責務（API 経由の任意昇格は禁止）なので、テスト前提の状態は prisma で直接 seed する。
    await prisma.candidate.update({ where: { id: a.id }, data: { stage: "top100" } });

    const all = await candidatesRoute.GET(new Request("http://localhost/api/candidates"));
    expect(all.status).toBe(200);
    expect(((await all.json()) as { data: CandidateData[] }).data.length).toBe(2);

    const filtered = await candidatesRoute.GET(
      new Request("http://localhost/api/candidates?stage=top100"),
    );
    const list = ((await filtered.json()) as { data: CandidateData[] }).data;
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(a.id);
  });

  it("returns 400 for an invalid stage filter", async () => {
    const res = await candidatesRoute.GET(
      new Request("http://localhost/api/candidates?stage=not_a_stage"),
    );
    expect(res.status).toBe(400);
  });

  it("updates a candidate (200) and 404 for a missing id", async () => {
    const cnd = await createCandidate({ title: "旧タイトル" });
    const res = await candidateIdRoute.PUT(jsonRequest("PUT", { title: "新タイトル" }), idCtx(cnd.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: CandidateData }).data.title).toBe("新タイトル");

    const missing = await candidateIdRoute.PUT(jsonRequest("PUT", { title: "x" }), idCtx("nope"));
    expect(missing.status).toBe(404);
  });

  it("soft-deletes (archives) a candidate via DELETE and 404 for a missing id", async () => {
    const cnd = await createCandidate();
    const res = await candidateIdRoute.DELETE(new Request("http://localhost/x"), idCtx(cnd.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: CandidateData }).data.stage).toBe("archived");
    // hard delete ではない（行は残り stage=archived）。
    expect(await prisma.candidate.count()).toBe(1);
    const reread = await prisma.candidate.findUnique({ where: { id: cnd.id } });
    expect(reread?.stage).toBe("archived");

    const missing = await candidateIdRoute.DELETE(new Request("http://localhost/x"), idCtx("nope"));
    expect(missing.status).toBe(404);
  });

  // stage 昇格は task-21 の専用 API の責務（§13 Out of scope）。作成/更新 API から任意の
  // stage を渡して進級ゲートを迂回した昇格をさせない（昇格=専用API / 棄却=reject / 退役=DELETE）。
  it("rejects stage input on POST with 400 and creates nothing", async () => {
    const res = await candidatesRoute.POST(
      jsonRequest("POST", { title: "昇格迂回", stage: "top100" }),
    );
    expect(res.status).toBe(400);
    // 昇格どころか作成もされない（stage を含む不正リクエストは丸ごと拒否）。
    expect(await prisma.candidate.count()).toBe(0);
  });

  it("rejects stage input on PUT with 400 and leaves stage unchanged", async () => {
    const cnd = await createCandidate();
    expect(cnd.stage).toBe("normalized");
    const res = await candidateIdRoute.PUT(
      jsonRequest("PUT", { stage: "top30" }),
      idCtx(cnd.id),
    );
    expect(res.status).toBe(400);
    // API 経由では昇格できない（stage は normalized のまま）。
    const reread = await prisma.candidate.findUnique({ where: { id: cnd.id } });
    expect(reread?.stage).toBe("normalized");
  });

  it("rejects stage even alongside a valid field on PUT (no partial apply)", async () => {
    const cnd = await createCandidate({ title: "旧" });
    const res = await candidateIdRoute.PUT(
      jsonRequest("PUT", { title: "新", stage: "focus" }),
      idCtx(cnd.id),
    );
    expect(res.status).toBe(400);
    // stage を含むと title 更新ごと拒否される（迂回の余地を残さない）。
    const reread = await prisma.candidate.findUnique({ where: { id: cnd.id } });
    expect(reread?.stage).toBe("normalized");
    expect(reread?.title).toBe("旧");
  });
});

// ---------------------------------------------------------------------------
// reject（reasonCode 必須）
// ---------------------------------------------------------------------------

describe("POST /api/candidates/[id]/reject", () => {
  it("rejects with a reason code and sets stage=rejected (200)", async () => {
    const cnd = await createCandidate();
    const res = await rejectRoute.POST(
      jsonRequest("POST", { rejectedReasonCode: "no_purchaser", rejectedReason: "買い手不在" }),
      idCtx(cnd.id),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: CandidateData };
    expect(data.stage).toBe("rejected");
    expect(data.rejectedReasonCode).toBe("no_purchaser");
  });

  it("returns 400 when rejecting without a reason code", async () => {
    const cnd = await createCandidate();
    const res = await rejectRoute.POST(jsonRequest("POST", {}), idCtx(cnd.id));
    expect(res.status).toBe(400);
    // 棄却されていない（stage は normalized のまま）。
    const reread = await prisma.candidate.findUnique({ where: { id: cnd.id } });
    expect(reread?.stage).toBe("normalized");
  });

  it("returns 400 for an invalid reason code enum", async () => {
    const cnd = await createCandidate();
    const res = await rejectRoute.POST(
      jsonRequest("POST", { rejectedReasonCode: "not_a_code" }),
      idCtx(cnd.id),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when rejecting a missing id", async () => {
    const res = await rejectRoute.POST(
      jsonRequest("POST", { rejectedReasonCode: "no_purchaser" }),
      idCtx("does-not-exist"),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// scoring/initial（計算・保存・ゲート）
// ---------------------------------------------------------------------------

describe("POST /api/scoring/initial/[candidateId]", () => {
  it("computes & saves InitialScore/confidence with configVersion and passes the gate", async () => {
    const cnd = await createCandidate();
    await seedStrongEvidence(cnd.id);

    const res = await scoringRoute.POST(scoringRequest(STRONG_INPUTS), candidateIdCtx(cnd.id));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        candidate: CandidateData;
        initialScore: number;
        confidence: number;
        gate: { pass: boolean; reasons: string[] };
      };
    };

    // InitialScore = 全軸 5 × 重み合計(5+4+3+3+3+2) = 100。
    expect(data.initialScore).toBe(100);
    // confidence = 0.4*min(2/3,1) + 0.3*(4/5) + 0.2*1 + 0.1*0（観測日時なし→recency 0）。
    expect(data.confidence).toBeCloseTo(0.4 * Math.min(2 / 3, 1) + 0.3 * (4 / 5) + 0.2, 5);
    // ゲート通過（reasons は空）。
    expect(data.gate.pass).toBe(true);
    expect(data.gate.reasons).toHaveLength(0);

    // 保存され configVersion が残っている（§8.10 監査）。
    const saved = await prisma.candidate.findUnique({ where: { id: cnd.id } });
    expect(saved?.initialScore).toBe(100);
    expect(saved?.scoreConfigVersion).toBe(scoringConfig.version);
    expect(saved?.confidence).toBeCloseTo(data.confidence, 5);
    // 素点（initialInputs）も保存され、再計算/監査に使える。
    expect(saved?.initialInputsJson).toContain("\"spend\":5");
  });

  it("returns gate.pass=false with reasons when below thresholds", async () => {
    const cnd = await createCandidate();
    // Evidence 無し・素点 0 → InitialScore 0 / distinct 0 / 強シグナル無し。
    const res = await scoringRoute.POST(scoringRequest(WEAK_INPUTS), candidateIdCtx(cnd.id));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { initialScore: number; gate: { pass: boolean; reasons: string[] } };
    };
    expect(data.initialScore).toBe(0);
    expect(data.gate.pass).toBe(false);
    // 少なくとも InitialScore 不足・独立チャネル不足・強シグナル無しの 3 理由。
    expect(data.gate.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("returns 400 for out-of-range raw inputs", async () => {
    const cnd = await createCandidate();
    const res = await scoringRoute.POST(
      scoringRequest({ ...STRONG_INPUTS, spend: 9 }),
      candidateIdCtx(cnd.id),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { issues?: unknown[] } };
    expect(Array.isArray(json.error.issues)).toBe(true);
  });

  it("returns 400 for missing raw inputs", async () => {
    const cnd = await createCandidate();
    const res = await scoringRoute.POST(scoringRequest({ spend: 5 }), candidateIdCtx(cnd.id));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the candidate does not exist", async () => {
    const res = await scoringRoute.POST(scoringRequest(STRONG_INPUTS), candidateIdCtx("does-not-exist"));
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const cnd = await createCandidate();
    const res = await scoringRoute.POST(scoringRequest("{ not json"), candidateIdCtx(cnd.id));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// top100（ゲート通過のみ）
// ---------------------------------------------------------------------------

describe("GET /api/candidates/top100", () => {
  it("returns only gate-passing candidates", async () => {
    // A: 強い素点 + 十分な Evidence → 採点して pass。
    const a = await createCandidate({ title: "通過A" });
    await seedStrongEvidence(a.id);
    await scoringRoute.POST(scoringRequest(STRONG_INPUTS), candidateIdCtx(a.id));

    // B: 採点済みだが弱い（Evidence 無し・素点 0）→ fail。
    const b = await createCandidate({ title: "不通過B" });
    await scoringRoute.POST(scoringRequest(WEAK_INPUTS), candidateIdCtx(b.id));

    // C: 未採点（initialScore null）→ 除外。
    const c = await createCandidate({ title: "未採点C" });

    const res = await top100Route.GET();
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: CandidateData[] };
    const ids = data.map((d) => d.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(c.id);
    expect(data).toHaveLength(1);
  });
});
