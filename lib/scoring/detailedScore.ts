import type { ScoringConfig } from "./config";

// DetailedScore + SignalBonus / UncertaintyPenalty — task-26, spec v2 §8.4-8.5。
//
// Top100 を通過した候補を Top30 へ絞り込むための詳細スコア。InitialScore（§8.1・市場
// デマンドのみ）と違い、12 軸（支払い意思 / 流入可能性 / 継続利用性 / 差別化 / Founder Fit 等）
// を加味する。v1 は重みのみで入力スケール未定義（実装不能）だったため、§8.4 で入力スケールを
// 確定: **各軸 0〜5 の素点 → DetailedScore = Σ(axis/5 * weight)**、重み合計100 → 最大100。
//
// 計算式（§8.4-8.5）:
//   DetailedScore = Σ ( axisScore_0to5 / 5 * weight_i )      # 重み合計100 → 最大100
//   TotalForGate  = DetailedScore + SignalBonus - UncertaintyPenalty
//
// すべて純粋関数（同入力→同出力・外部 I/O なし）。重み・ボーナス額は引数の config から読む
// （task-03 の ScoringConfig。重み外部化を保つ・ハードコード禁止）。
//
// Out of scope: Top30 ゲート判定（task-27）/ DB 保存（task-30）。confidence は §8.6 の別軸
// （task-06）であり本モジュールには含めない（スコアと confidence は併置表示・§8.5 注記）。

/**
 * DetailedScore の入力素点。各軸 0〜5（§8.4）。
 * キーは config.detailedWeights と 1:1 対応する（重みを軸ごとに引くため）。
 */
export interface DetailedInputs {
  /** 既存支出（重み15） */
  spend: number;
  /** 支払い意思 / WTP（重み10） */
  wtp: number;
  /** 流入可能性 / 獲得しやすさ（重み10） */
  acquisition: number;
  /** Pain 強度（重み10） */
  pain: number;
  /** 発生頻度（重み8） */
  frequency: number;
  /** 継続利用性 / retention（重み8） */
  retention: number;
  /** 競合不満（重み8） */
  competitorPain: number;
  /** 差別化余地（重み8） */
  differentiation: number;
  /** 形態適合 / form fit（重み7） */
  formFit: number;
  /** Product-Founder Fit（重み6） */
  pfFit: number;
  /** 開発 / 運用容易性（重み5） */
  buildEase: number;
  /** 法務 / ポリシー安全性（重み5） */
  legalSafety: number;
}

/**
 * 不確実性ペナルティのレベル（§8.5・人間判断で1つ選ぶ）。
 * gateTop100 の StrongSignalType と同様、スコアリング内部のカテゴリは局所 union 型で表す
 * （task-02 のドメイン enum ではないため Zod スキーマ経由にはしない）。
 *   - "enough"      直接証拠が十分（ペナルティなし）
 *   - "mixed"       強い推測が混在する
 *   - "unconfirmed" 主要前提が未確認
 */
export type UncertaintyLevel = "enough" | "mixed" | "unconfirmed";

/**
 * UncertaintyPenalty のレベル → 減点幅（正の大きさ）。§8.5: 0 / -5 / -10。
 * ここでは「引く量」を正の数で持ち、totalForGate で減算する。
 */
const UNCERTAINTY_PENALTY: Record<UncertaintyLevel, number> = {
  enough: 0,
  mixed: 5,
  unconfirmed: 10,
};

/**
 * DetailedScore（最大100）を計算する純粋関数（§8.4）。
 *
 * `Σ(inputs[axis] / 5 * config.detailedWeights[axis])` を返す。各軸 0〜5 を想定するが、
 * 範囲検証・丸めは行わない（純粋な加重和）。素点の検証は呼び出し側（入力層）の責務。
 * 全軸満点（5）なら重み合計（=100）に一致し、全軸 0 なら 0 になる。
 *
 * 重みはすべて引数の config から読むため、config を差し替えれば結果が変わる（外部化の確認）。
 */
export function detailedScore(inputs: DetailedInputs, config: ScoringConfig): number {
  const w = config.detailedWeights;
  return (
    (inputs.spend / 5) * w.spend +
    (inputs.wtp / 5) * w.wtp +
    (inputs.acquisition / 5) * w.acquisition +
    (inputs.pain / 5) * w.pain +
    (inputs.frequency / 5) * w.frequency +
    (inputs.retention / 5) * w.retention +
    (inputs.competitorPain / 5) * w.competitorPain +
    (inputs.differentiation / 5) * w.differentiation +
    (inputs.formFit / 5) * w.formFit +
    (inputs.pfFit / 5) * w.pfFit +
    (inputs.buildEase / 5) * w.buildEase +
    (inputs.legalSafety / 5) * w.legalSafety
  );
}

/**
 * SignalBonus を計算する純粋関数（§8.5）。
 *
 * distinct な sourceType 数（複数チャネルの一致度）に応じて加点する:
 *   +0(1ソース) / +5(2ソース) / +10(3ソース) / +15(4ソース以上 かつ 支出証拠あり)
 *
 * 4ソース以上でも支出証拠がなければプレミアム（+15）は付かず、3ソース相当の加点に留める
 * （単調・支出証拠を伴ってはじめて最上位ボーナス）。加点額は config.signalBonus から読む。
 *
 * @param distinctSourceTypes Evidence 由来の distinct な sourceType 数（同一ソース複数件は1）。
 * @param hasSpend            支出証拠が1つ以上あるか（+15 の条件）。
 */
export function signalBonus(
  distinctSourceTypes: number,
  hasSpend: boolean,
  config: ScoringConfig,
): number {
  const bonus = config.signalBonus;
  if (distinctSourceTypes >= 4 && hasSpend) {
    return bonus["4plusWithSpend"];
  }
  if (distinctSourceTypes >= 3) {
    return bonus["3"];
  }
  if (distinctSourceTypes >= 2) {
    return bonus["2"];
  }
  return 0;
}

/**
 * UncertaintyPenalty（減点幅・正の数）を返す純粋関数（§8.5）。
 *
 * レベルは人間が判断して渡す（証拠十分 / 強い推測混在 / 主要前提未確認）。
 * 返り値は「引く量」を正の数で表す（0 / 5 / 10）。totalForGate で減算される。
 */
export function uncertaintyPenalty(level: UncertaintyLevel): number {
  return UNCERTAINTY_PENALTY[level];
}

/**
 * TotalForGate を合成する純粋関数（§8.4）。
 *
 *   TotalForGate = DetailedScore + SignalBonus - UncertaintyPenalty
 *
 * 3 つの計算済みサブスコアを受け取り合成する（detailedScore / signalBonus は加点、
 * uncertaintyPenalty は正の減点幅なので減算）。Top30 ゲート判定（task-27）はこの値を使う。
 */
export function totalForGate(
  detailedScoreValue: number,
  signalBonusValue: number,
  uncertaintyPenaltyValue: number,
): number {
  return detailedScoreValue + signalBonusValue - uncertaintyPenaltyValue;
}
