import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// task-21 Evidence 一覧 GET API（spec v2 §9.5 / §9.6）:
// - GET /api/candidates/[id]/evidence は候補に紐付く Evidence を返す
// - 証拠 0 件は 200 で空配列（候補は存在する）
// - 存在しない候補 id は 404
//
// candidate.api.test.ts と同方式で、本物の route → repository → DB 経路を検証する。
// 専用 SQLite に DATABASE_URL を向けてから client / handler を動的 import する。dev.db は触らない。

let dbDir: string;
let prisma: PrismaClient;
let candidatesRoute: typeof import("../../app/api/candidates/route");
let evidenceRoute: typeof import("../../app/api/candidates/[id]/evidence/route");

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-candidate-evidence-"));
  const url = `file:${join(dbDir, "test.db")}`;
  process.env.DATABASE_URL = url;
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  ({ prisma } = await import("../../lib/db/client"));
  candidatesRoute = await import("../../app/api/candidates/route");
  evidenceRoute = await import("../../app/api/candidates/[id]/evidence/route");
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

type CandidateData = { id: string; displayId: string };
type EvidenceData = { id: string; evidenceType: string; strength: number };

function idCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function createCandidate(): Promise<CandidateData> {
  const res = await candidatesRoute.POST(
    new Request("http://localhost/api/candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Evidence テスト候補" }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: CandidateData }).data;
}

async function makeRawSignal(sourceType: string): Promise<{ id: string }> {
  seq += 1;
  return prisma.rawSignal.create({
    data: { displayId: `RS-EV-${seq}`, sourceType, rawText: "観測事実" },
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

function getRequest(): Request {
  return new Request("http://localhost/api/candidates/x/evidence", {
    headers: { Accept: "application/json" },
  });
}

describe("GET /api/candidates/[id]/evidence", () => {
  it("lists evidence linked to the candidate (200)", async () => {
    const cnd = await createCandidate();
    const rs1 = await makeRawSignal("app_store");
    const rs2 = await makeRawSignal("review");
    await linkEvidence(cnd.id, rs1.id, "spend", 4);
    await linkEvidence(cnd.id, rs2.id, "dissatisfaction", 3);

    const res = await evidenceRoute.GET(getRequest(), idCtx(cnd.id));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: EvidenceData[] };
    expect(data).toHaveLength(2);
    expect(new Set(data.map((e) => e.evidenceType))).toEqual(
      new Set(["spend", "dissatisfaction"]),
    );
  });

  it("returns an empty array for a candidate with no evidence (200)", async () => {
    const cnd = await createCandidate();
    const res = await evidenceRoute.GET(getRequest(), idCtx(cnd.id));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: EvidenceData[] };
    expect(data).toEqual([]);
  });

  it("only returns evidence for the requested candidate", async () => {
    const a = await createCandidate();
    const b = await createCandidate();
    const rs = await makeRawSignal("app_store");
    await linkEvidence(a.id, rs.id, "spend", 4);

    const resB = await evidenceRoute.GET(getRequest(), idCtx(b.id));
    expect(resB.status).toBe(200);
    expect(((await resB.json()) as { data: EvidenceData[] }).data).toEqual([]);
  });

  it("returns 404 for a missing candidate id", async () => {
    const res = await evidenceRoute.GET(getRequest(), idCtx("does-not-exist"));
    expect(res.status).toBe(404);
  });
});
