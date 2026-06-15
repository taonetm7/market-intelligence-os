import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// DecisionLog 履歴 API（task-31・案A スコープ追加。spec v2 §7.6 / §15.3）。
// GET /api/candidates/[id]/decision-logs は decisionLogRepo.listByCandidate を薄く包むだけ:
// - 判断ログを新しい順（decidedAt 降順・id 降順）で返す
// - ログが無い候補は空配列（200）
// - 存在しない id は 404（空配列と「対象なし」を区別する）
//
// candidatePromote.test.ts と同方式で、本物の route → repository → DB 経路を検証する。
// 専用 SQLite に DATABASE_URL を向けてから client / handler を動的 import する。dev.db は触らない。
// テストの import は相対パス（@/ エイリアスは vitest 非対応）。

let dbDir: string;
let prisma: PrismaClient;
let route: typeof import("../../app/api/candidates/[id]/decision-logs/route");

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-decision-logs-"));
  const url = `file:${join(dbDir, "test.db")}`;
  process.env.DATABASE_URL = url;
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  ({ prisma } = await import("../../lib/db/client"));
  route = await import("../../app/api/candidates/[id]/decision-logs/route");
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.decisionLog.deleteMany();
  await prisma.candidate.deleteMany();
});

let seq = 0;

function idCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function createCandidate(): Promise<{ id: string }> {
  seq += 1;
  return prisma.candidate.create({
    data: { displayId: `CND-DL-${seq}`, title: "判断ログテスト候補" },
  });
}

type DecisionLogRow = {
  id: string;
  decisionType: string;
  fromStage: string | null;
  toStage: string | null;
  reason: string;
};

describe("GET /api/candidates/[id]/decision-logs", () => {
  it("判断ログを新しい順（decidedAt 降順）で返す（200）", async () => {
    const cnd = await createCandidate();
    // 古い順に作るが、decidedAt を明示して順序を決定論にする。
    await prisma.decisionLog.create({
      data: {
        candidateId: cnd.id,
        decisionType: "promote",
        fromStage: "normalized",
        toStage: "top100",
        reason: "normalized→top100 へ昇格",
        decidedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    await prisma.decisionLog.create({
      data: {
        candidateId: cnd.id,
        decisionType: "promote",
        fromStage: "top100",
        toStage: "top30",
        reason: "top100→top30 へ昇格",
        decidedAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    });

    const res = await route.GET(new Request("http://localhost/x"), idCtx(cnd.id));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: DecisionLogRow[] };
    expect(data).toHaveLength(2);
    // 新しい順: 後の判断（top100→top30）が先頭。
    expect(data[0]?.toStage).toBe("top30");
    expect(data[1]?.toStage).toBe("top100");
    expect(data[0]?.decisionType).toBe("promote");
  });

  it("判断ログが無ければ空配列を返す（200）", async () => {
    const cnd = await createCandidate();
    const res = await route.GET(new Request("http://localhost/x"), idCtx(cnd.id));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: DecisionLogRow[] };
    expect(data).toEqual([]);
  });

  it("存在しない candidate は 404", async () => {
    const res = await route.GET(new Request("http://localhost/x"), idCtx("does-not-exist"));
    expect(res.status).toBe(404);
  });
});
