import type { ScoringConfig } from "./config";

// InitialScore（市場デマンドのみ・config重み）— task-04, spec v2 §8.1。
//
// 市場の足切りゲート用スコア。お金の動き（Spend）を最大重みに置き、
// 開発者属性（FounderFit / BuildEase）や legalRisk / opsRisk は **含めない**
// （それらは Candidate に素点保存するが、Top100 市場ゲートには使わない・§8.1 注記）。
//
// 計算式（§8.1）:
//   InitialScore = Σ(score_axis * weight_axis)
//   既定重み spend5 / dissatisfaction4 / pain3 / frequency3 / discoverability3 / substitute2
//   各軸 0〜5 → 最大 (5+4+3+3+3+2)*5 = 100。重みは scoring.config.json で変更可能。
//
// 純粋関数（同入力→同出力・外部 I/O なし）。重みは引数の config から読む
// （task-03 の ScoringConfig を使い、重み外部化を保つ）。

/** InitialScore の入力素点。各軸 0〜5（§8.1）。 */
export interface InitialInputs {
  /** 既存支出（サブスク/外注/テンプレ/講座/SaaS費） */
  spend: number;
  /** 競合不満 */
  dissatisfaction: number;
  /** 痛みの強さ（損失・時間浪費・ストレス） */
  pain: number;
  /** 発生頻度（日/週/月） */
  frequency: number;
  /** 検索・ASO・SNS・コミュニティで届くか */
  discoverability: number;
  /** 現代替手段（Excel/紙/手作業/外注）の面倒さ */
  substitute: number;
}

/**
 * 市場デマンドのみで構成する InitialScore（最大100）を計算する純粋関数。
 *
 * `Σ(inputs[axis] * config.initialWeights[axis])` を返す。重みは config から読むため、
 * config を差し替えれば結果が変わる（重み外部化の確認）。FounderFit / BuildEase /
 * legalRisk / opsRisk は計算に含めない（§8.1）。
 *
 * 入力素点は各軸 0〜5 を想定するが、この関数は範囲検証・丸めを行わない（純粋な加重和）。
 * 素点の検証は呼び出し側（入力層）の責務。
 */
export function computeInitialScore(inputs: InitialInputs, config: ScoringConfig): number {
  const w = config.initialWeights;
  return (
    inputs.spend * w.spend +
    inputs.dissatisfaction * w.dissatisfaction +
    inputs.pain * w.pain +
    inputs.frequency * w.frequency +
    inputs.discoverability * w.discoverability +
    inputs.substitute * w.substitute
  );
}
