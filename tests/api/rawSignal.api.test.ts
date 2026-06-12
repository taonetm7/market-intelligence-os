import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// task-11 acceptance criteria (spec v2 §13 Slice 1):
// - 一覧（フィルタ反映）/ 作成 / 取得 / 更新 / 削除の API
// - 不正入力で 400 ＋ エラー詳細
// - 存在しない id で 404
//
// route handler は repository を経由し、repository は PrismaClient シングルトンを使う。
// テストでは専用の SQLite ファイルへ DATABASE_URL を向けてからシングルトン（client）と
// route handler を動的 import し、本物の route → repository → DB 経路を検証する。
// dev.db は触らない。

let dbDir: string;
let prisma: PrismaClient;
// 動的 import した route handler 群（DATABASE_URL 設定後に読み込む）。
let listRoute: typeof import("../../app/api/raw-signals/route");
let idRoute: typeof import("../../app/api/raw-signals/[id]/route");

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-rawsignal-api-"));
  const url = `file:${join(dbDir, "test.db")}`;
  process.env.DATABASE_URL = url;
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  // DATABASE_URL 設定後に読み込む（シングルトンがこの URL で構築される）。
  ({ prisma } = await import("../../lib/db/client"));
  listRoute = await import("../../app/api/raw-signals/route");
  idRoute = await import("../../app/api/raw-signals/[id]/route");
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
// リクエスト生成ヘルパ
// ---------------------------------------------------------------------------

function inputFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceType: "app_store",
    rawText: "観測事実: あるアプリの星1レビューが急増",
    ...overrides,
  };
}

function listRequest(query = ""): Request {
  return new Request(`http://localhost/api/raw-signals${query}`);
}

function jsonRequest(method: string, body: unknown): Request {
  return new Request("http://localhost/api/raw-signals", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawBodyRequest(method: string, raw: string): Request {
  return new Request("http://localhost/api/raw-signals", {
    method,
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

// POST route 経由で 1 件作成し、その data を返す補助。
async function createViaApi(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; displayId: string; [k: string]: unknown }> {
  const res = await listRoute.POST(jsonRequest("POST", inputFixture(overrides)));
  expect(res.status).toBe(201);
  const json = (await res.json()) as { data: { id: string; displayId: string } };
  return json.data;
}

// ---------------------------------------------------------------------------
// GET 一覧
// ---------------------------------------------------------------------------

describe("GET /api/raw-signals (list)", () => {
  it("returns all signals wrapped in { data }", async () => {
    await createViaApi({ rawText: "one" });
    await createViaApi({ rawText: "two" });

    const res = await listRoute.GET(listRequest());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toHaveLength(2);
  });

  it("filters by sourceType", async () => {
    await createViaApi({ sourceType: "app_store" });
    await createViaApi({ sourceType: "review" });

    const res = await listRoute.GET(listRequest("?sourceType=review"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ sourceType: string }> };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]?.sourceType).toBe("review");
  });

  it("filters by status", async () => {
    await createViaApi({ status: "inbox" });
    await createViaApi({ status: "ignored" });

    const res = await listRoute.GET(listRequest("?status=ignored"));
    const json = (await res.json()) as { data: Array<{ status: string }> };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]?.status).toBe("ignored");
  });

  it("filters unlinked=1 to zero-evidence inbox signals", async () => {
    const linked = await createViaApi({ rawText: "linked", status: "inbox" });
    const unlinked = await createViaApi({ rawText: "unlinked", status: "inbox" });
    // Evidence を直接 1 件作って linked を紐付け済みにする。
    const candidate = await prisma.candidate.create({
      data: { displayId: "CND-001", title: "テスト候補" },
    });
    await prisma.evidence.create({
      data: {
        candidateId: candidate.id,
        rawSignalId: linked.id,
        evidenceType: "dissatisfaction",
        strength: 3,
      },
    });

    const res = await listRoute.GET(listRequest("?unlinked=1"));
    const json = (await res.json()) as { data: Array<{ id: string }> };
    expect(json.data.map((r) => r.id)).toEqual([unlinked.id]);
  });

  it("filters by q (contains search)", async () => {
    await createViaApi({ rawText: "needle in the text" });
    await createViaApi({ rawText: "unrelated" });

    const res = await listRoute.GET(listRequest("?q=needle"));
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toHaveLength(1);
  });

  it("returns 400 with details for an invalid sourceType filter", async () => {
    const res = await listRoute.GET(listRequest("?sourceType=not_a_source"));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string; issues?: unknown[] } };
    expect(json.error.message).toBeTruthy();
    expect(Array.isArray(json.error.issues)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST 作成
// ---------------------------------------------------------------------------

describe("POST /api/raw-signals (create)", () => {
  it("creates a signal and returns 201 with { data }", async () => {
    const res = await listRoute.POST(
      jsonRequest("POST", inputFixture({ sourceName: "App Store" })),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { id: string; displayId: string; sourceName: string };
    };
    expect(json.data.id).toBeTruthy();
    expect(json.data.displayId).toMatch(/^RS-\d{8}-\d{3}$/);
    expect(json.data.sourceName).toBe("App Store");
  });

  it("returns 400 with issues for invalid input (missing rawText)", async () => {
    const res = await listRoute.POST(jsonRequest("POST", { sourceType: "app_store" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string; issues?: unknown[] } };
    expect(Array.isArray(json.error.issues)).toBe(true);
    expect(json.error.issues?.length).toBeGreaterThan(0);
  });

  it("returns 400 with an invalid enum value", async () => {
    const res = await listRoute.POST(
      jsonRequest("POST", inputFixture({ sourceType: "not_a_source" })),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const res = await listRoute.POST(rawBodyRequest("POST", "{ not json"));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// GET 取得
// ---------------------------------------------------------------------------

describe("GET /api/raw-signals/[id]", () => {
  it("returns the record for an existing id", async () => {
    const created = await createViaApi({ rawText: "fetch me" });

    const res = await idRoute.GET(new Request("http://localhost/x"), ctx(created.id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string; rawText: string } };
    expect(json.data.id).toBe(created.id);
    expect(json.data.rawText).toBe("fetch me");
  });

  it("returns 404 for a missing id", async () => {
    const res = await idRoute.GET(new Request("http://localhost/x"), ctx("does-not-exist"));
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// PUT 更新
// ---------------------------------------------------------------------------

describe("PUT /api/raw-signals/[id]", () => {
  it("updates only the provided fields and returns 200", async () => {
    const created = await createViaApi({ note: "before", signalTags: ["a"] });

    const res = await idRoute.PUT(
      jsonRequest("PUT", { status: "archived", signalTags: ["a", "b"] }),
      ctx(created.id),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { status: string; signalTags: string[]; note: string };
    };
    expect(json.data.status).toBe("archived");
    expect(json.data.signalTags).toEqual(["a", "b"]);
    // 触れていないフィールドは保持される。
    expect(json.data.note).toBe("before");
  });

  it("returns 400 for invalid input", async () => {
    const created = await createViaApi();
    const res = await idRoute.PUT(
      jsonRequest("PUT", { status: "linked" }), // "linked" は廃止された status
      ctx(created.id),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { issues?: unknown[] } };
    expect(Array.isArray(json.error.issues)).toBe(true);
  });

  it("returns 404 when updating a missing id", async () => {
    const res = await idRoute.PUT(jsonRequest("PUT", { note: "x" }), ctx("does-not-exist"));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE 削除
// ---------------------------------------------------------------------------

describe("DELETE /api/raw-signals/[id]", () => {
  it("deletes an existing record and returns 200", async () => {
    const created = await createViaApi();

    const res = await idRoute.DELETE(new Request("http://localhost/x"), ctx(created.id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string } };
    expect(json.data.id).toBe(created.id);

    // 続けて取得すると 404。
    const after = await idRoute.GET(new Request("http://localhost/x"), ctx(created.id));
    expect(after.status).toBe(404);
  });

  it("returns 404 when deleting a missing id", async () => {
    const res = await idRoute.DELETE(new Request("http://localhost/x"), ctx("does-not-exist"));
    expect(res.status).toBe(404);
  });
});
