// Seed data — task-24, spec v2 §18.6 / 背景資料 market_candidate_collection_operations_v2.md §12。
//
// operation の実例5件（請求書/証憑・英語学習記録・SNS投稿代行・営業リスト・インボイス対応）を、
// Raw Signal → Candidate → Evidence link → スコア/ゲートまで一通り投入する。UI が空にならない
// ＋スコア E2E の土台にする（§18.5/§18.6）。
//
// 設計方針:
// - 素データは seed/fixtures/*.json に分離（このファイルは投入オーケストレーションのみ）。
// - 既存 repository（rawSignalRepo / candidateRepo / evidenceRepo）だけを使い、Prisma は直接
//   触らない（クリア処理を除く）。enum 文字列は直書きせず task-02 の Zod スキーマ経由で検証する
//   （各 repo の入口で parse される）。
// - スコアは純粋関数に委譲する（computeInitialScore / computeConfidence / evaluateTop100Gate）。
//   結線の手順は app/api/scoring/initial/[candidateId]/route.ts（task-13）と同じにする。
// - 冪等: 実行のたびにコア5テーブルをクリアしてから入れ直す（再実行で件数が増えない・§18.6）。
// - Top100 ゲートを通る例（3件）と通らない例（2件: スコア不足／強シグナル無しの2境界）を混ぜる。
//
// 実行系（pnpm seed）: 外部の TS ランナー依存（tsx/ts-node 等）を足さず、Node 同梱の TS 実行で動かす。
// - package.json の seed は `node --experimental-transform-types seed/seed.ts`。lib は parameter
//   property（evidenceRepo の EvidenceDuplicateLinkError 等）を含むため、strip-only ではなく
//   transform を使う。
// - lib は拡張子なしの相対 import と attribute 無しの JSON import（scoring/config.ts）を内部で使う。
//   Node 標準の ESM 解決は拡張子を補完せず JSON は import attribute を要求するため、CLI 起動時のみ
//   最小の resolve/load フックを register して両者を吸収する（外部依存ゼロ・data: URL でインライン保持）。
// - vitest からは runSeed を import して使う（その場合フックは登録しない＝vite が解決する）。
//   そのため lib への参照はすべて関数内の動的 import にし、トップレベルでは型のみを import する。

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { PrismaClient } from "@prisma/client";

import type { CandidateCreate, SettableStage } from "../lib/db/candidateRepo";
import type { EvidenceLinkArgs } from "../lib/db/evidenceRepo";
import type { StrongSignalType } from "../lib/scoring/gateTop100";
import type { EvidenceType, SourceType, SpendType } from "../lib/validation/enums";
import type { InitialInputs, RawSignalInput } from "../lib/validation/schemas";

// ---------------------------------------------------------------------------
// fixture の型（seed/fixtures/*.json の素データ形）
// ---------------------------------------------------------------------------

interface RawSignalFixture {
  sourceType: SourceType;
  sourceName?: string;
  sourceUrl?: string;
  country?: string;
  language?: string;
  rawText: string;
  observedEntity?: string;
  observedPrice?: string;
  observedRank?: string;
  observedRating?: number;
  observedReviews?: number;
  observedUpdate?: string;
  signalTags?: string[];
  note?: string;
}

interface EvidenceFixture {
  /** 同じ fixture 内 rawSignals の index（その RawSignal に link する）。 */
  rawSignal: number;
  evidenceType: EvidenceType;
  strength: number;
  credibility?: number;
  note?: string;
}

interface CandidateFixture {
  problemFamily?: string;
  title: string;
  targetUser?: string;
  contextTrigger?: string;
  painStatement?: string;
  currentSubstitute?: string;
  spendType?: SpendType;
  monetizationGuess?: string;
  productFormFit?: string[];
  legalRisk?: number;
  opsRisk?: number;
  founderFit?: number;
  buildEase?: number;
  testableWithinDays?: number;
  testMethod?: string;
  nextAction?: string;
}

interface Fixture {
  key: string;
  /** 期待する Top100 ゲートの結果（ドキュメント兼テストの突き合わせ用）。 */
  top100: "pass" | "fail";
  /** fail のとき、どの境界で落ちる想定かのメモ。 */
  failReason?: string;
  candidate: CandidateFixture;
  initialInputs: InitialInputs;
  rawSignals: RawSignalFixture[];
  evidence: EvidenceFixture[];
}

// ---------------------------------------------------------------------------
// 投入結果（pnpm seed の表示・tests/seed.test.ts の検証に使う）
// ---------------------------------------------------------------------------

export interface SeedCandidateResult {
  key: string;
  displayId: string;
  initialScore: number;
  confidence: number;
  gatePass: boolean;
  gateReasons: string[];
  evidenceCount: number;
  distinctSourceTypes: number;
}

export interface SeedResult {
  candidates: number;
  rawSignals: number;
  evidence: number;
  results: SeedCandidateResult[];
}

// ---------------------------------------------------------------------------
// recency / 強シグナル集合（task-13 の route と同じ式・閾値）
// ---------------------------------------------------------------------------

/** recencyFactor を [0,1] に正規化する窓（日）。この窓より古い観測は寄与 0。 */
const RECENCY_WINDOW_DAYS = 180;
const MS_PER_DAY = 86_400_000;

/**
 * 最新観測時刻から recencyFactor（0〜1）を導出する（§8.6: 直近観測ほど高い）。
 * 観測が無ければ 0、RECENCY_WINDOW_DAYS 以内なら線形に 1→0 へ減衰する。
 * confidence.ts は recency の正規化を呼び出し側の責務にしているためここで吸収する。
 */
function recencyFactor(latestObservedAt: Date | null, now: Date): number {
  if (latestObservedAt === null) return 0;
  const days = (now.getTime() - latestObservedAt.getTime()) / MS_PER_DAY;
  return Math.min(Math.max(1 - days / RECENCY_WINDOW_DAYS, 0), 1);
}

/**
 * signalStats の強シグナル集合（Set<EvidenceType>）を、Top100 ゲートが要求する
 * Set<StrongSignalType>（spend / dissatisfaction / search）へ絞り込む。
 * enum 文字列は直書きせず evidenceRepo の STRONG_SIGNAL_TYPES を経由する。
 */
function toStrongSignalSet(
  types: ReadonlySet<EvidenceType>,
  strongTypes: readonly StrongSignalType[],
): Set<StrongSignalType> {
  const strong = new Set<StrongSignalType>();
  for (const type of strongTypes) {
    if (types.has(type)) strong.add(type);
  }
  return strong;
}

// ---------------------------------------------------------------------------
// fixture 読み込み
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** seed/fixtures/*.json をファイル名昇順（= 例1..例5）で読み込む。 */
function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8")) as Fixture);
}

// ---------------------------------------------------------------------------
// seed 本体
// ---------------------------------------------------------------------------

/**
 * 5例の素データを投入する。冪等（実行のたびにコア5テーブルをクリアしてから入れ直す）。
 *
 * @param db 投入先 Prisma クライアント。省略時は lib/db/client のシングルトン
 *           （= DATABASE_URL の dev.db）。テストは専用の SQLite を注入する。
 * @param now recency 計算の基準時刻（既定は現在時刻）。テストの決定論性のため注入可能。
 */
export async function runSeed(db?: PrismaClient, now: Date = new Date()): Promise<SeedResult> {
  // lib は CLI 実行時のみ register したフックで解決される（vitest では vite が解決）。
  // どちらでも動くよう、lib への参照はここで動的 import する。
  const [
    { rawSignalRepo },
    { STRONG_SIGNAL_TYPES, evidenceRepo },
    candidateRepoMod,
    { scoringConfig },
    { computeInitialScore },
    { computeConfidence },
    { evaluateTop100Gate },
    { stageSchema },
    { prisma },
  ] = await Promise.all([
    import("../lib/db/rawSignalRepo"),
    import("../lib/db/evidenceRepo"),
    import("../lib/db/candidateRepo"),
    import("../lib/scoring/config"),
    import("../lib/scoring/initialScore"),
    import("../lib/scoring/confidence"),
    import("../lib/scoring/gateTop100"),
    import("../lib/validation/enums"),
    import("../lib/db/client"),
  ]);
  const { candidateRepo } = candidateRepoMod;
  const client: PrismaClient = db ?? prisma;
  // enum 値は直書きせず Zod スキーマ経由で得る（§注意: enum 文字列の直書き禁止）。
  const TOP100_STAGE = stageSchema.enum.top100 satisfies SettableStage;

  // --- 冪等性: コア5テーブルを FK 安全な順でクリアしてから入れ直す（§18.6） ---
  // Evidence→RawSignal は onDelete: Restrict のため Evidence を先に消す。
  await client.evidence.deleteMany();
  await client.scoreSnapshot.deleteMany();
  await client.decisionLog.deleteMany();
  await client.candidate.deleteMany();
  await client.rawSignal.deleteMany();

  const fixtures = loadFixtures();
  const result: SeedResult = { candidates: 0, rawSignals: 0, evidence: 0, results: [] };

  for (const fx of fixtures) {
    // 1. RawSignal を複数投入する。rawSignalRepo.create は内部で $transaction を張るため、
    //    Prisma の $transaction にネストせず順次呼ぶ（displayId 採番の競合を局所化する設計）。
    const rawSignalIds: string[] = [];
    for (const rs of fx.rawSignals) {
      const created = await rawSignalRepo.create(rs as RawSignalInput, client);
      rawSignalIds.push(created.id);
      result.rawSignals += 1;
    }

    // 2. Candidate を1件作成する（派生スコアは saveScores で後入れ・§7.3）。
    const candidate = await candidateRepo.create(fx.candidate as CandidateCreate, client);
    result.candidates += 1;

    // 3. Evidence link（複数 sourceType に跨り distinctSourceTypes>=2 を作る・§8.2）。
    for (const ev of fx.evidence) {
      const args: EvidenceLinkArgs = {
        candidateId: candidate.id,
        rawSignalId: rawSignalIds[ev.rawSignal],
        evidenceType: ev.evidenceType,
        strength: ev.strength,
        credibility: ev.credibility,
        note: ev.note,
      };
      await evidenceRepo.link(args, client);
      result.evidence += 1;
    }

    // 4. スコア計算（task-13 route と同じ結線: stats → 純粋関数）。
    const initialScore = computeInitialScore(fx.initialInputs, scoringConfig);
    const stats = await evidenceRepo.signalStatsByCandidate(candidate.id, client);
    const confidence = computeConfidence({
      distinctSourceTypes: stats.distinctSourceTypes,
      avgEvidenceStrength: stats.avgStrength,
      hasDirectSpendEvidence: stats.hasDirectSpend ? 1 : 0,
      recencyFactor: recencyFactor(stats.latestObservedAt, now),
    });
    const gate = evaluateTop100Gate(
      {
        initialScore,
        distinctSourceTypes: stats.distinctSourceTypes,
        strongSignalTypes: toStrongSignalSet(stats.strongSignalTypes, STRONG_SIGNAL_TYPES),
        legalRisk: fx.initialInputs.legalRisk,
        opsRisk: fx.initialInputs.opsRisk,
      },
      scoringConfig,
    );

    // 5. 素点・派生スコア・configVersion を保存（§7.3 再計算/監査のため素点も残す）。
    await candidateRepo.saveScores(
      candidate.id,
      {
        initialInputs: fx.initialInputs,
        initialScore,
        confidence,
        scoreConfigVersion: scoringConfig.version,
      },
      client,
    );

    // 6. ゲート通過は stage を top100 へ進める（通過/不通過を UI・ダッシュボードで可視化する）。
    if (gate.pass) {
      await candidateRepo.setStage(candidate.id, TOP100_STAGE, client);
    }

    result.results.push({
      key: fx.key,
      displayId: candidate.displayId,
      initialScore,
      confidence,
      gatePass: gate.pass,
      gateReasons: gate.reasons,
      evidenceCount: fx.evidence.length,
      distinctSourceTypes: stats.distinctSourceTypes,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI ランナー（pnpm seed）
// ---------------------------------------------------------------------------

// lib の拡張子なし相対 import と config.ts の JSON import を、Node 型ストリップ実行でも
// 解決できるようにする最小フック（外部依存ゼロ）。CLI 起動時のみ data: URL で register する。
const LOADER_HOOK_SOURCE = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const EXT = [".ts", ".tsx", ".mts", ".js", ".mjs", ".json"];
export async function resolve(spec, ctx, next) {
  try {
    return await next(spec, ctx);
  } catch (err) {
    if (!(spec.startsWith("./") || spec.startsWith("../")) || !ctx.parentURL) throw err;
    const base = new URL(spec, ctx.parentURL);
    const path = fileURLToPath(base);
    for (const ext of EXT) {
      if (existsSync(path + ext)) return { url: base.href + ext, shortCircuit: true };
    }
    for (const ext of EXT) {
      if (existsSync(path + "/index" + ext)) return { url: base.href + "/index" + ext, shortCircuit: true };
    }
    throw err;
  }
}
export async function load(url, ctx, next) {
  if (url.endsWith(".json")) {
    return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: "json" } });
  }
  return next(url, ctx);
}
`;

/** CLI 実行時に resolve/load フックを登録する（lib をロードする前に呼ぶ）。 */
async function registerLoaderHooks(): Promise<void> {
  const { register } = await import("node:module");
  register(`data:text/javascript,${encodeURIComponent(LOADER_HOOK_SOURCE)}`, import.meta.url);
}

/** pnpm seed の本体: 投入 → 結果サマリ表示 → Prisma 切断。 */
async function main(): Promise<void> {
  const result = await runSeed();
  const passed = result.results.filter((r) => r.gatePass);
  const failed = result.results.filter((r) => !r.gatePass);

  console.log(
    `seed 完了: Candidate ${result.candidates} / RawSignal ${result.rawSignals} / Evidence ${result.evidence}`,
  );
  for (const r of result.results) {
    const mark = r.gatePass ? "○ Top100通過" : "× 不通過";
    console.log(
      `  ${r.displayId} [${r.key}] ${mark} initialScore=${r.initialScore} confidence=${r.confidence.toFixed(2)}` +
        (r.gatePass ? "" : ` 理由: ${r.gateReasons.join(" / ")}`),
    );
  }
  console.log(`Top100 ゲート: 通過 ${passed.length} 件 / 不通過 ${failed.length} 件`);

  const { prisma } = await import("../lib/db/client");
  await prisma.$disconnect();
}

// `node seed/seed.ts` で直接起動されたときだけ CLI を実行する。
// vitest 等から import されたときは runSeed を export するだけで、ここは走らない。
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await registerLoaderHooks();
  await main().catch((error: unknown) => {
    console.error("seed に失敗しました:", error);
    process.exitCode = 1;
  });
}
