import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { watchlistEntityTypeSchema } from "../../lib/validation/enums";

// task-36 Phase 2（Codexレビュー指摘）: linkedCandidateId 不在時の 400/404 変換を route 層で検証する。
// - POST /api/watchlist に不在の linkedCandidateId → 404（FK 500 でないこと）
// - PUT /api/watchlist/[id] に不在の linkedCandidateId → 404 かつ「Watchlist 不在」と区別されること
// - 正常系（紐付けあり）が退行しないこと
//
// evidenceLink.api.test.ts と同方式: 専用 SQLite に DATABASE_URL を向けてから client / handler を
// 動的 import する（シングルトンがこの URL で構築される）。dev.db は触らない。import は相対パス。

let dbDir: string;
let prisma: PrismaClient;
let listRoute: typeof import("../../app/api/watchlist/route");
let itemRoute: typeof import("../../app/api/watchlist/[id]/route");

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-watchlist-api-"));
  const url = `file:${join(dbDir, "test.db")}`;
  process.env.DATABASE_URL = url;
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  ({ prisma } = await import("../../lib/db/client"));
  listRoute = await import("../../app/api/watchlist/route");
  itemRoute = await import("../../app/api/watchlist/[id]/route");
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // FK 順に削除（Watchlist → Candidate）。
  await prisma.watchlist.deleteMany();
  await prisma.candidate.deleteMany();
});

// ---------------------------------------------------------------------------
// fixtures / helpers
// ---------------------------------------------------------------------------

let seq = 0;

async function makeCandidate(): Promise<{ id: string }> {
  seq += 1;
  return prisma.candidate.create({
    data: { displayId: `CND-WL-${seq}`, title: "紐付け候補" },
  });
}

function wlBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entityType: watchlistEntityTypeSchema.enum.competitor_app,
    entityName: "Acme 請求書アプリ",
    metricName: "ランキング",
    ...overrides,
  };
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/watchlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api/watchlist/x", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// POST /api/watchlist — linkedCandidateId の存在確認
// ---------------------------------------------------------------------------

describe("POST /api/watchlist", () => {
  it("creates with a valid linkedCandidateId and returns 201（正常系・退行確認）", async () => {
    const cnd = await makeCandidate();
    const res = await listRoute.POST(postRequest(wlBody({ linkedCandidateId: cnd.id })));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string; linkedCandidateId: string } };
    expect(json.data.linkedCandidateId).toBe(cnd.id);
    expect(await prisma.watchlist.count()).toBe(1);
  });

  it("returns 404 (not 500) when linkedCandidateId does not exist", async () => {
    const res = await listRoute.POST(postRequest(wlBody({ linkedCandidateId: "does-not-exist" })));
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("Candidate");
    // FK 違反で行が作られていないこと。
    expect(await prisma.watchlist.count()).toBe(0);
  });

  it("creates without linkedCandidateId（未指定は存在確認不要）", async () => {
    const res = await listRoute.POST(postRequest(wlBody()));
    expect(res.status).toBe(201);
    expect(await prisma.watchlist.count()).toBe(1);
  });

  it("returns 400 (not 500) when linkedCandidateId is an empty string", async () => {
    // 空文字は .min(1) で弾かれ、FK へ渡らず 500 にならない（Codex 追加指摘）。
    const res = await listRoute.POST(postRequest(wlBody({ linkedCandidateId: "" })));
    expect(res.status).toBe(400);
    // 行が作られていないこと（FK 経路を踏んでいない）。
    expect(await prisma.watchlist.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/watchlist/[id] — Watchlist 不在 404 と紐付け先 candidate 不在 404 の区別
// ---------------------------------------------------------------------------

describe("PUT /api/watchlist/[id]", () => {
  async function createWatchlist(): Promise<{ id: string }> {
    const res = await listRoute.POST(postRequest(wlBody()));
    return (await res.json()).data as { id: string };
  }

  it("returns 404 with a Watchlist-not-found message for a missing id", async () => {
    const res = await itemRoute.PUT(putRequest({ note: "x" }), ctx("does-not-exist"));
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("Watchlist");
    expect(json.error.message).not.toContain("紐付け先");
  });

  it("returns 404 distinguishing the linked Candidate (not Watchlist) when linkedCandidateId is missing", async () => {
    const wl = await createWatchlist();
    const res = await itemRoute.PUT(
      putRequest({ linkedCandidateId: "does-not-exist" }),
      ctx(wl.id),
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { message: string } };
    // 原因が「紐付け先 candidate の不在」として区別されること（Watchlist 不在の誤変換でない）。
    expect(json.error.message).toContain("紐付け先");
    expect(json.error.message).toContain("Candidate");
  });

  it("returns 400 (not 500) when linkedCandidateId is an empty string", async () => {
    // PUT も同じスキーマ派生を通るため、空文字は 400 になり FK 500 にならない（Codex 追加指摘）。
    const wl = await createWatchlist();
    const res = await itemRoute.PUT(putRequest({ linkedCandidateId: "" }), ctx(wl.id));
    expect(res.status).toBe(400);
    // 既存行の紐付けが書き換わっていないこと。
    const fetched = await prisma.watchlist.findUnique({ where: { id: wl.id } });
    expect(fetched?.linkedCandidateId).toBeNull();
  });

  it("updates with a valid linkedCandidateId and returns 200（正常系・退行確認）", async () => {
    const wl = await createWatchlist();
    const cnd = await makeCandidate();
    const res = await itemRoute.PUT(putRequest({ linkedCandidateId: cnd.id }), ctx(wl.id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { linkedCandidateId: string } };
    expect(json.data.linkedCandidateId).toBe(cnd.id);
  });
});
