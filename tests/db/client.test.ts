import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Startup smoke test (task-01 acceptance criteria #4):
// lib/db/client のシングルトン（生成済み Prisma Client）が接続でき、各コアモデルが
// freshly migrated・空のデータベースに対して count 0 を返すことを確認する。
//
// 以前は dev.db を空前提で count=0 を検証していたが、pnpm seed（task-24）が dev.db に
// 投入すると衝突して落ちた。他の DB テストと同様に、専用 SQLite へ DATABASE_URL を向けて
// から client を動的 import する方式へ変更し、dev.db の状態に依存しないようにする
// （シングルトン配線の検証という本来の意図は維持する）。

let dbDir: string;
let prisma: PrismaClient;

beforeAll(async () => {
  // 一時ディレクトリに空の SQLite を用意し、現行スキーマを push する。
  dbDir = mkdtempSync(join(tmpdir(), "mi-client-"));
  const url = `file:${join(dbDir, "test.db")}`;
  process.env.DATABASE_URL = url;
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  // DATABASE_URL 設定後に読み込む（シングルトンがこの URL で構築される）。
  ({ prisma } = await import("../../lib/db/client"));
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("prisma client startup", () => {
  it("connects to the database", async () => {
    await expect(prisma.$connect()).resolves.toBeUndefined();
  });

  it("reports count 0 for every core model on an empty database", async () => {
    const [rawSignals, candidates, evidences, scoreSnapshots, decisionLogs] = await Promise.all([
      prisma.rawSignal.count(),
      prisma.candidate.count(),
      prisma.evidence.count(),
      prisma.scoreSnapshot.count(),
      prisma.decisionLog.count(),
    ]);

    expect(rawSignals).toBe(0);
    expect(candidates).toBe(0);
    expect(evidences).toBe(0);
    expect(scoreSnapshots).toBe(0);
    expect(decisionLogs).toBe(0);
  });
});
