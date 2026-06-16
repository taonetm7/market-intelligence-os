import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// GET /api/candidates/[id]/duplicates の薄い API テスト（task-34 Phase 2・Codex 指摘対応）。
// spec v2 §9.7 / §3.3。route ハンドラ → duplicateRepo → DB の本物の経路で受入条件を検証する:
// - 200 ＋ { data: [{ candidate, score, matched }] }（score 降順）
// - threshold / limit クエリが反映される
// - 存在しない candidateId は 200 ＋ 空配列（404 にしない＝「似た候補なし」）
// - 不正クエリ（threshold が範囲外）は 400
//
// candidatePromote.test.ts と同方式: 専用 SQLite に DATABASE_URL を向けてから client / handler を
// 動的 import する（route の prisma シングルトンが test DB を指す）。dev.db は触らない。

let dbDir: string;
let prisma: PrismaClient;
let candidatesRoute: typeof import("../../app/api/candidates/route");
let duplicatesRoute: typeof import("../../app/api/candidates/[id]/duplicates/route");

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-duplicates-api-"));
  const url = `file:${join(dbDir, "test.db")}`;
  process.env.DATABASE_URL = url;
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  ({ prisma } = await import("../../lib/db/client"));
  candidatesRoute = await import("../../app/api/candidates/route");
  duplicatesRoute = await import("../../app/api/candidates/[id]/duplicates/route");
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

type CandidateData = { id: string; displayId: string; stage: string };
type Suggestion = {
  candidate: { id: string };
  score: number;
  matched: { field: string; similarity: number }[];
};

function idCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

const BASE_FEATURES = {
  problemFamily: "請求書の作成と送付",
  targetUser: "個人事業主",
  contextTrigger: "月末の締め作業",
  painStatement: "毎月手作業で請求書を作るのが面倒",
  currentSubstitute: "Excel テンプレート",
};

async function createCandidate(overrides: Record<string, unknown> = {}): Promise<CandidateData> {
  const res = await candidatesRoute.POST(
    new Request("http://localhost/api/candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "重複APIテスト候補", ...BASE_FEATURES, ...overrides }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: CandidateData }).data;
}

/** problemFamily / painStatement / targetUser を共有する近い候補（明確に閾値以上）。 */
const NEAR_OVERRIDES = {
  title: "請求書候補（別表現）",
  contextTrigger: "監査対応",
  currentSubstitute: "基幹システム",
};

/** テキストもタグも被らない無関係候補。 */
const UNRELATED_OVERRIDES = {
  title: "観光候補",
  problemFamily: "観光地の混雑予測",
  targetUser: "自治体の観光課",
  contextTrigger: "大型連休",
  painStatement: "人出が読めず人員配置に失敗する",
  currentSubstitute: "過去の勘",
};

function get(id: string, query = ""): Promise<Response> {
  const req = new Request(`http://localhost/api/candidates/${id}/duplicates${query}`);
  return duplicatesRoute.GET(req, idCtx(id));
}

describe("GET /api/candidates/[id]/duplicates", () => {
  it("似た候補を 200 ＋ { data: [{ candidate, score, matched }] } で返す", async () => {
    const target = await createCandidate();
    const near = await createCandidate(NEAR_OVERRIDES);
    await createCandidate(UNRELATED_OVERRIDES);

    const res = await get(target.id);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Suggestion[] };

    // 近い候補のみ（無関係は閾値未満で落ちる・自分自身も出ない）。
    expect(data.map((d) => d.candidate.id)).toEqual([near.id]);
    expect(data[0].score).toBeGreaterThan(0);
    expect(data[0].matched.map((m) => m.field)).toContain("problemFamily");
  });

  it("threshold クエリが反映される（高閾値で空になる）", async () => {
    const target = await createCandidate();
    await createCandidate(NEAR_OVERRIDES);

    const def = (await (await get(target.id)).json()) as { data: Suggestion[] };
    expect(def.data).toHaveLength(1);

    const strict = await get(target.id, "?threshold=0.95");
    expect(strict.status).toBe(200);
    const { data } = (await strict.json()) as { data: Suggestion[] };
    expect(data).toEqual([]);
  });

  it("limit クエリが反映される（スコア降順で上位 N 件）", async () => {
    const target = await createCandidate();
    const exact = await createCandidate(); // 完全一致（score 最大）
    await createCandidate(NEAR_OVERRIDES); // 部分一致

    const all = (await (await get(target.id)).json()) as { data: Suggestion[] };
    expect(all.data.length).toBe(2);

    const res = await get(target.id, "?limit=1");
    const { data } = (await res.json()) as { data: Suggestion[] };
    expect(data).toHaveLength(1);
    expect(data[0].candidate.id).toBe(exact.id);
  });

  it("存在しない candidateId は 200 ＋ 空配列（404 にしない）", async () => {
    const res = await get("does-not-exist");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Suggestion[] };
    expect(data).toEqual([]);
  });

  it("不正な threshold（範囲外）は 400", async () => {
    const target = await createCandidate();
    const res = await get(target.id, "?threshold=2");
    expect(res.status).toBe(400);
  });
});
