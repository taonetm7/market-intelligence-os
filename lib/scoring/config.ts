import { z } from "zod";

import scoringConfigJson from "../../config/scoring.config.json";

// Scoring config loader (task-03, spec v2 §8.10).
//
// スコアの重み・閾値を外部 JSON (config/scoring.config.json) に出し、
// version 付きでロードする層。task-04/05/06/13 のスコア計算がこの型を参照する。
//
// 運用ルール:
// - JSON はコメント不可。閾値・重みを変更したら **手で `version` を上げる**こと
//   （例 "2026.06-v1" → "2026.07-v1"）。ScoreSnapshot に configVersion を残し、
//   再重み付け後も過去スコアを解釈可能にするため (§8.10)。
// - config は不変の前提。読み込みは起動時に1回・Zod 検証（不正なら throw＝早期失敗）。
//
// Out of scope: スコア計算本体 (task-04〜06) / UI からの config 編集 (Slice 2 以降)。

// 重み・閾値は較正前の仮置き。再重み付けで小数になり得るため number で受ける。
const weight = z.number();

// initialWeights — 初期スコア(§8.1)の素点重み
const initialWeightsSchema = z
  .object({
    spend: weight,
    dissatisfaction: weight,
    pain: weight,
    frequency: weight,
    discoverability: weight,
    substitute: weight,
  })
  .strict();

// detailedWeights — 詳細スコア(§8.x)の重み
const detailedWeightsSchema = z
  .object({
    spend: weight,
    wtp: weight,
    acquisition: weight,
    pain: weight,
    frequency: weight,
    retention: weight,
    competitorPain: weight,
    differentiation: weight,
    formFit: weight,
    pfFit: weight,
    buildEase: weight,
    legalSafety: weight,
  })
  .strict();

// signalBonus — distinct source 数に応じたボーナス
const signalBonusSchema = z
  .object({
    "2": z.number(),
    "3": z.number(),
    "4plusWithSpend": z.number(),
  })
  .strict();

// gates.top100 — Top100 進級ゲート
const top100GateSchema = z
  .object({
    minScore: z.number(),
    minDistinctSources: z.number().int(),
    maxLegalRisk: z.number().int(),
    maxOpsRisk: z.number().int(),
  })
  .strict();

// gates.top30 — Top30 進級ゲート
const top30GateSchema = z
  .object({
    minTotal: z.number(),
    minConfidence: z.number().min(0).max(1),
    minDistinctSources: z.number().int(),
    maxTestDays: z.number().int(),
  })
  .strict();

const gatesSchema = z
  .object({
    top100: top100GateSchema,
    top30: top30GateSchema,
  })
  .strict();

export const scoringConfigSchema = z
  .object({
    version: z.string().min(1),
    initialWeights: initialWeightsSchema,
    detailedWeights: detailedWeightsSchema,
    signalBonus: signalBonusSchema,
    gates: gatesSchema,
  })
  .strict();

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;

/**
 * scoring.config.json を Zod 検証して返す。
 * 不正な config（重み欠落・型違い・未知キー）のときは throw する（早期失敗）。
 * 引数なしの既定は同梱 JSON を読む。`raw` を渡すとテストで任意 config を検証できる。
 */
export function loadScoringConfig(raw: unknown = scoringConfigJson): ScoringConfig {
  return scoringConfigSchema.parse(raw);
}

// 起動時に1回読んで検証する（不正 config はこの時点で throw）。
export const scoringConfig: ScoringConfig = loadScoringConfig();

/** 現在ロードされている config の version 文字列を返す。 */
export function getConfigVersion(): string {
  return scoringConfig.version;
}
