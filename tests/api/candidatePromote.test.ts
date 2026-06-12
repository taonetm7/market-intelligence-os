import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// task-21 promote API（spec v2 §8.2 / §8.9）:
// - normalized→top100 の1段昇格（Top100 ゲート通過時のみ・人間操作）
// - 未採点 / ゲート未通過は 422（reasons 付き）
// - normalized 以外の stage は 409（昇格対象でない／自動昇格しない）
// - 存在しない id は 404
//
// candidate.api.test.ts と同方式で、本物の route → repository → DB 経路を検証する。
// 専用 SQLite に DATABASE_URL を向けてから client / handler を動的 import する。dev.db は触らない。

let dbDir: string;
let prisma: PrismaClient;
let candidatesRoute: typeof import("../../app/api/candidates/route");
let promoteRoute: typeof import("../../app/api/candidates/[id]/promote/route");
let scoringRoute: typeof import("../../app/api/scoring/initial/[candidateId]/route");

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-candidate-promote-"));
  const url = `file:${join(dbDir, "test.db")}`;
  process.env.DATABASE_URL = url;
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  ({ prisma } = await import("../../lib/db/client"));
  candidatesRoute = await import("../../app/api/candidates/route");
  promoteRoute = await import("../../app/api/candidates/[id]/promote/route");
  scoringRoute = await import("../../app/api/scoring/initial/[candidateId]/route");
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.evidence.deleteMany();
  await prisma.rawSignal.deleteMany();
  await prisma.candidate.deleteMany();
});

let seq = 0;

type CandidateData = { id: string; displayId: string; stage: string };

function idCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}
function candidateIdCtx(candidateId: string): { params: Promise<{ candidateId: string }> } {
  return { params: Promise.resolve({ candidateId }) };
}

async function createCandidate(): Promise<CandidateData> {
  const res = await candidatesRoute.POST(
    new Request("http://localhost/api/candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "昇格テスト候補" }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: CandidateData }).data;
}

async function makeRawSignal(sourceType: string): Promise<{ id: string }> {
  seq += 1;
  return prisma.rawSignal.create({
    data: { displayId: `RS-PRM-${seq}`, sourceType, rawText: "観測事実" },
  });
}

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

/** 2 つの distinct source + 強シグナル（spend/dissatisfaction）を付与する（ゲート通過の前提）。 */
async function seedStrongEvidence(candidateId: string): Promise<void> {
  const rs1 = await makeRawSignal("app_store");
  const rs2 = await makeRawSignal("review");
  await linkEvidence(candidateId, rs1.id, "spend", 4);
  await linkEvidence(candidateId, rs2.id, "dissatisfaction", 4);
}

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
    body: JSON.stringify(body),
  });
}

async function score(candidateId: string, inputs: unknown): Promise<void> {
  const res = await scoringRoute.POST(scoringRequest(inputs), candidateIdCtx(candidateId));
  expect(res.status).toBe(200);
}

function promoteRequest(): Request {
  return new Request("http://localhost/api/candidates/x/promote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

describe("POST /api/candidates/[id]/promote", () => {
  it("promotes normalized→top100 when the Top100 gate passes (200)", async () => {
    const cnd = await createCandidate();
    await seedStrongEvidence(cnd.id);
    await score(cnd.id, STRONG_INPUTS);

    const res = await promoteRoute.POST(promoteRequest(), idCtx(cnd.id));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: CandidateData };
    expect(data.stage).toBe("top100");
    // 永続化されている（人間操作で 1 段だけ昇格）。
    const reread = await prisma.candidate.findUnique({ where: { id: cnd.id } });
    expect(reread?.stage).toBe("top100");
  });

  it("returns 422 when the candidate is not scored yet", async () => {
    const cnd = await createCandidate();
    const res = await promoteRoute.POST(promoteRequest(), idCtx(cnd.id));
    expect(res.status).toBe(422);
    // 昇格していない（normalized のまま）。
    const reread = await prisma.candidate.findUnique({ where: { id: cnd.id } });
    expect(reread?.stage).toBe("normalized");
  });

  it("returns 422 with reasons when the gate fails (weak inputs / no evidence)", async () => {
    const cnd = await createCandidate();
    await score(cnd.id, WEAK_INPUTS);

    const res = await promoteRoute.POST(promoteRequest(), idCtx(cnd.id));
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { reasons?: string[] } };
    // 不足理由（InitialScore 不足・独立チャネル不足・強シグナル無し）が返る。
    expect(Array.isArray(json.error.reasons)).toBe(true);
    expect((json.error.reasons ?? []).length).toBeGreaterThanOrEqual(1);
    const reread = await prisma.candidate.findUnique({ where: { id: cnd.id } });
    expect(reread?.stage).toBe("normalized");
  });

  it("returns 409 when promoting from a non-normalized stage (no double promote)", async () => {
    const cnd = await createCandidate();
    await seedStrongEvidence(cnd.id);
    await score(cnd.id, STRONG_INPUTS);

    const first = await promoteRoute.POST(promoteRequest(), idCtx(cnd.id));
    expect(first.status).toBe(200);
    // 既に top100 → もう一度昇格しようとすると 409（Slice 1 は normalized からのみ）。
    const second = await promoteRoute.POST(promoteRequest(), idCtx(cnd.id));
    expect(second.status).toBe(409);
    const reread = await prisma.candidate.findUnique({ where: { id: cnd.id } });
    expect(reread?.stage).toBe("top100");
  });

  it("returns 404 when promoting a missing id", async () => {
    const res = await promoteRoute.POST(promoteRequest(), idCtx("does-not-exist"));
    expect(res.status).toBe(404);
  });
});
