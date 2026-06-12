import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// task-12 acceptance criteria (spec v2 §9.6 / §13):
// - RawSignal を Candidate に Evidence として link / unlink する API
// - link 成功で Evidence 作成・signalStatsByCandidate 返却
// - rawSignalId / candidateId 不在で 404、二重 link で 409
// - unlink（DELETE）で Evidence 削除、不在 id で 404
// - 不正入力 / 不正 JSON で 400
//
// rawSignal.api.test.ts と同方式で、本物の route → repository → DB 経路を検証する。
// 専用 SQLite に DATABASE_URL を向けてから client / handler を動的 import する。dev.db は触らない。

let dbDir: string;
let prisma: PrismaClient;
// 動的 import した route handler 群（DATABASE_URL 設定後に読み込む）。
let linkRoute: typeof import("../../app/api/raw-signals/[id]/link-candidate/route");
let evidenceRoute: typeof import("../../app/api/evidence/[id]/route");

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-evidence-link-api-"));
  const url = `file:${join(dbDir, "test.db")}`;
  process.env.DATABASE_URL = url;
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  // DATABASE_URL 設定後に読み込む（シングルトンがこの URL で構築される）。
  ({ prisma } = await import("../../lib/db/client"));
  linkRoute = await import("../../app/api/raw-signals/[id]/link-candidate/route");
  evidenceRoute = await import("../../app/api/evidence/[id]/route");
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

async function makeRawSignal(): Promise<{ id: string }> {
  seq += 1;
  return prisma.rawSignal.create({
    data: { displayId: `RS-TEST-${seq}`, sourceType: "app_store", rawText: "観測事実" },
  });
}

async function makeCandidate(): Promise<{ id: string }> {
  seq += 1;
  return prisma.candidate.create({
    data: { displayId: `CND-TEST-${seq}`, title: "テスト候補" },
  });
}

function linkRequest(body: unknown): Request {
  return new Request("http://localhost/api/raw-signals/x/link-candidate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// POST link
// ---------------------------------------------------------------------------

describe("POST /api/raw-signals/[id]/link-candidate (link)", () => {
  it("links a RawSignal to a Candidate and returns 201 with stats", async () => {
    const rs = await makeRawSignal();
    const cnd = await makeCandidate();

    const res = await linkRoute.POST(
      linkRequest({ candidateId: cnd.id, evidenceType: "dissatisfaction", strength: 4 }),
      ctx(rs.id),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: {
        evidence: { id: string; rawSignalId: string; candidateId: string; evidenceType: string };
        stats: { distinctSourceTypes: number; avgStrength: number; strongSignalTypes: string[] };
      };
    };
    expect(json.data.evidence.id).toBeTruthy();
    expect(json.data.evidence.rawSignalId).toBe(rs.id);
    expect(json.data.evidence.candidateId).toBe(cnd.id);
    expect(json.data.evidence.evidenceType).toBe("dissatisfaction");
    // stats（signalStatsByCandidate）が同梱され、今 link した証拠を反映している。
    expect(json.data.stats.distinctSourceTypes).toBe(1);
    expect(json.data.stats.avgStrength).toBe(4);
    expect(json.data.stats.strongSignalTypes).toContain("dissatisfaction");

    // DB に Evidence が 1 件作られている。
    expect(await prisma.evidence.count()).toBe(1);
  });

  it("returns 404 when the rawSignalId (path) does not exist", async () => {
    const cnd = await makeCandidate();
    const res = await linkRoute.POST(
      linkRequest({ candidateId: cnd.id, evidenceType: "dissatisfaction", strength: 3 }),
      ctx("does-not-exist"),
    );
    expect(res.status).toBe(404);
    expect(await prisma.evidence.count()).toBe(0);
  });

  it("returns 404 when the candidateId (body) does not exist", async () => {
    const rs = await makeRawSignal();
    const res = await linkRoute.POST(
      linkRequest({ candidateId: "does-not-exist", evidenceType: "dissatisfaction", strength: 3 }),
      ctx(rs.id),
    );
    expect(res.status).toBe(404);
    expect(await prisma.evidence.count()).toBe(0);
  });

  it("returns 409 for a duplicate link (same candidate/raw/type)", async () => {
    const rs = await makeRawSignal();
    const cnd = await makeCandidate();
    const body = { candidateId: cnd.id, evidenceType: "dissatisfaction", strength: 3 };

    const first = await linkRoute.POST(linkRequest(body), ctx(rs.id));
    expect(first.status).toBe(201);

    const second = await linkRoute.POST(linkRequest(body), ctx(rs.id));
    expect(second.status).toBe(409);
    // 重複は作られない（1 件のまま）。
    expect(await prisma.evidence.count()).toBe(1);
  });

  it("returns 400 with issues for invalid input (strength out of range)", async () => {
    const rs = await makeRawSignal();
    const cnd = await makeCandidate();
    const res = await linkRoute.POST(
      linkRequest({ candidateId: cnd.id, evidenceType: "dissatisfaction", strength: 9 }),
      ctx(rs.id),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string; issues?: unknown[] } };
    expect(Array.isArray(json.error.issues)).toBe(true);
    expect(json.error.issues?.length).toBeGreaterThan(0);
  });

  it("returns 400 for an invalid evidenceType enum", async () => {
    const rs = await makeRawSignal();
    const cnd = await makeCandidate();
    const res = await linkRoute.POST(
      linkRequest({ candidateId: cnd.id, evidenceType: "not_a_type", strength: 3 }),
      ctx(rs.id),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const rs = await makeRawSignal();
    const res = await linkRoute.POST(linkRequest("{ not json"), ctx(rs.id));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// DELETE unlink
// ---------------------------------------------------------------------------

describe("DELETE /api/evidence/[id] (unlink)", () => {
  it("deletes an existing Evidence and returns 200", async () => {
    const rs = await makeRawSignal();
    const cnd = await makeCandidate();
    const linkRes = await linkRoute.POST(
      linkRequest({ candidateId: cnd.id, evidenceType: "dissatisfaction", strength: 3 }),
      ctx(rs.id),
    );
    const linked = (await linkRes.json()) as { data: { evidence: { id: string } } };
    const evidenceId = linked.data.evidence.id;

    const res = await evidenceRoute.DELETE(new Request("http://localhost/x"), ctx(evidenceId));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string } };
    expect(json.data.id).toBe(evidenceId);

    // DB から削除されている。
    expect(await prisma.evidence.count()).toBe(0);
  });

  it("returns 404 when deleting a missing id", async () => {
    const res = await evidenceRoute.DELETE(
      new Request("http://localhost/x"),
      ctx("does-not-exist"),
    );
    expect(res.status).toBe(404);
  });
});
