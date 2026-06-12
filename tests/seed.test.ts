import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runSeed, type SeedResult } from "../seed/seed";

// task-24 acceptance criteria（spec v2 §18.6 / 背景資料 §12）:
// - pnpm seed（= runSeed）で 5候補・複数 RawSignal・複数 Evidence が投入される
// - 各候補に distinctSourceTypes>=2 の Evidence が紐付き、InitialScore/confidence が計算済み
// - Top100 ゲートを通る例（≥1）と通らない例（≥1）が混在する
// - 冪等（2回実行で件数が増えない）
//
// 専用の SQLite ファイルへ向けた PrismaClient を runSeed に注入し、dev.db は触らない。
// recency 依存を排すため固定時刻（fixtures の観測日に近い 2026-06-12）を注入する。

const FIXED_NOW = new Date(2026, 5, 12); // 2026-06-12（ローカル）

let dbDir: string;
let db: PrismaClient;

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-seed-"));
  const url = `file:${join(dbDir, "test.db")}`;
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  // runSeed は内部で lib/db/client（シングルトン）も動的 import する。構築時に
  // 不正な DATABASE_URL でエラーにならないよう、テスト DB の URL を環境にも向けておく
  // （実際の投入は注入した db に対してのみ行われる）。
  process.env.DATABASE_URL = url;
  db = new PrismaClient({ datasources: { db: { url } } });
});

afterAll(async () => {
  await db.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // 各テスト前に空にする（runSeed 自身も冪等にクリアするが、件数前提を明示する）。
  await db.evidence.deleteMany();
  await db.scoreSnapshot.deleteMany();
  await db.decisionLog.deleteMany();
  await db.candidate.deleteMany();
  await db.rawSignal.deleteMany();
});

describe("seed data（task-24）", () => {
  it("投入で 5候補・13 RawSignal・13 Evidence が作られる", async () => {
    const result = await runSeed(db, FIXED_NOW);

    expect(result.candidates).toBe(5);
    expect(result.rawSignals).toBe(13);
    expect(result.evidence).toBe(13);
    expect(result.results).toHaveLength(5);

    // DB の実件数も一致する。
    expect(await db.candidate.count()).toBe(5);
    expect(await db.rawSignal.count()).toBe(13);
    expect(await db.evidence.count()).toBe(13);
  });

  it("各候補に Evidence が紐付き、distinctSourceTypes>=2 になる", async () => {
    const result = await runSeed(db, FIXED_NOW);

    for (const r of result.results) {
      expect(r.evidenceCount).toBeGreaterThanOrEqual(2);
      expect(r.distinctSourceTypes).toBeGreaterThanOrEqual(2);
    }

    // 関係性: 全 Evidence が実在の Candidate / RawSignal を指している。
    const candidates = await db.candidate.findMany({
      include: { _count: { select: { evidences: true } } },
    });
    for (const c of candidates) {
      expect(c._count.evidences).toBeGreaterThanOrEqual(2);
    }
  });

  it("InitialScore / confidence / scoreConfigVersion / 素点が保存済みになる", async () => {
    await runSeed(db, FIXED_NOW);

    const candidates = await db.candidate.findMany();
    expect(candidates).toHaveLength(5);
    for (const c of candidates) {
      expect(c.initialScore).not.toBeNull();
      expect(c.initialScore).toBeGreaterThan(0);
      expect(c.confidence).not.toBeNull();
      expect(c.confidence as number).toBeGreaterThan(0);
      expect(c.confidence as number).toBeLessThanOrEqual(1);
      expect(c.scoreConfigVersion).toBeTruthy();
      // 素点（initialInputs）が空オブジェクト/未設定でなく往復保存されている。
      expect(c.initialInputsJson).toBeTruthy();
      expect(c.initialInputsJson).not.toBe("{}");
      const inputs = JSON.parse(c.initialInputsJson ?? "{}");
      expect(inputs).toMatchObject({ spend: expect.any(Number), pain: expect.any(Number) });
    }
  });

  it("Top100 ゲートを通る例と通らない例が混在する（境界確認用）", async () => {
    const result = await runSeed(db, FIXED_NOW);

    const passed = result.results.filter((r) => r.gatePass);
    const failed = result.results.filter((r) => !r.gatePass);
    expect(passed.length).toBeGreaterThanOrEqual(1);
    expect(failed.length).toBeGreaterThanOrEqual(1);

    // 既知の期待（fixtures の top100 メモと一致）:
    const byKey = new Map(result.results.map((r) => [r.key, r]));
    expect(byKey.get("receipts")?.gatePass).toBe(true);
    expect(byKey.get("sns-posting")?.gatePass).toBe(true);
    expect(byKey.get("invoice")?.gatePass).toBe(true);
    // english-study はスコア不足、sales-list は強シグナル無しで不通過。
    expect(byKey.get("english-study")?.gatePass).toBe(false);
    expect(byKey.get("sales-list")?.gatePass).toBe(false);
    expect(byKey.get("english-study")?.gateReasons.join()).toMatch(/InitialScore/);
    expect(byKey.get("sales-list")?.gateReasons.join()).toMatch(/強シグナル/);

    // 通過した候補は stage=top100 に進んでいる。
    const top100 = await db.candidate.findMany({ where: { stage: "top100" } });
    expect(top100).toHaveLength(passed.length);
  });

  it("冪等: 2回実行しても件数が増えない", async () => {
    const first = await runSeed(db, FIXED_NOW);
    const firstCounts = {
      candidate: await db.candidate.count(),
      rawSignal: await db.rawSignal.count(),
      evidence: await db.evidence.count(),
    };

    const second: SeedResult = await runSeed(db, FIXED_NOW);
    const secondCounts = {
      candidate: await db.candidate.count(),
      rawSignal: await db.rawSignal.count(),
      evidence: await db.evidence.count(),
    };

    expect(secondCounts).toEqual(firstCounts);
    expect(secondCounts).toEqual({ candidate: 5, rawSignal: 13, evidence: 13 });
    // 戻り値の件数も一致（投入処理自体が安定）。
    expect(second.candidates).toBe(first.candidates);
    expect(second.rawSignals).toBe(first.rawSignals);
    expect(second.evidence).toBe(first.evidence);
  });
});
