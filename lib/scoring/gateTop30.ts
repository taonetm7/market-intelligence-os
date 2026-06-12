import type { ScoringConfig } from "./config";

// Top30 進級ゲート — task-27, spec v2 §8.7。
//
// TotalForGate（§8.4 DetailedScore + SignalBonus - UncertaintyPenalty・task-26）を通過した
// 候補が Top30 に進級できるかを、config.gates.top30 の閾値で判定する純粋関数。
// Top100→Top30 の絞り込みでは「高スコアだが検証不能」を弾くため、**検証可能性をバイナリ必須化**
// する（testableWithinDays が定義され、かつ maxTestDays 以内であること）。
//
// 判定式（§8.7・閾値は config から読む。ハードコード禁止）:
//   TotalForGate >= minTotal(既定68)
//   ∧ confidence >= minConfidence(既定0.7)                  （§8.6 confidence・task-06）
//   ∧ distinctSourceTypes >= minDistinctSources(既定3)
//   ∧ testableWithinDays が未設定(null)でなく <= maxTestDays(既定7)
//
// testableWithinDays = null は「検証手段が未定義」を意味し、検証可能性ゲートを **不合格** とする
// （高スコアでも検証できない候補は進級させない・§8.7 の趣旨）。
//
// 不正入力の扱い（fail-safe）: ゲートの目的は「進級させてよいかの確認」なので、判定できない
// 入力は安全側＝**不合格**に倒す。具体的には、各数値が非有限（NaN / ±Infinity）の場合、および
// testableWithinDays が負数（日数として無意味）の場合を不合格とする。NaN は `<`/`>` 比較が
// すべて false になり素通りしうるため、明示的に弾く必要がある。
//
// 純粋関数（副作用・外部 I/O・グローバル状態なし）。
//
// Out of scope: TotalForGate の算出（task-26）/ confidence 計算（task-06）/ DB 反映（task-30）/
// Top15 の人間判断（§8.8）。本関数は算出済みの値を受けて判定するだけ。

/** Top30 ゲートの入力。各値の算出・検証は呼び出し側の責務（本関数は判定に専念）。 */
export interface GateTop30Inputs {
  /** §8.4 TotalForGate（DetailedScore + SignalBonus - UncertaintyPenalty）。 */
  totalForGate: number;
  /** §8.6 confidence（0〜1）。 */
  confidence: number;
  /** Evidence 由来の distinct な sourceType 数（同一ソースの複数件は1とカウント）。 */
  distinctSourceTypes: number;
  /**
   * 検証可能になるまでの日数。`null` は検証手段が未定義であることを表し、不合格扱いとする
   * （検証可能性ゲートの趣旨・§8.7）。負数は日数として無意味なため不合格扱い。
   */
  testableWithinDays: number | null;
}

/** Top30 ゲートの判定結果。 */
export interface GateTop30Result {
  /** 全条件を満たすと true。 */
  pass: boolean;
  /** 不足条件を人間可読で列挙（全条件満たす場合は空配列）。 */
  reasons: string[];
}

/**
 * Top30 進級ゲートを判定する純粋関数（§8.7）。
 *
 * `config.gates.top30` の閾値（minTotal / minConfidence / minDistinctSources / maxTestDays）の
 * 全条件を満たすかを判定し、`{ pass, reasons }` を返す。`reasons` には満たせなかった条件を
 * 人間可読で列挙する（全条件を満たす場合は `[]`）。
 *
 * `testableWithinDays` が `null`（検証手段未定義）の場合は maxTestDays 比較を行わず、
 * 検証可能性ゲートを不合格にする。
 *
 * 閾値はすべて引数の config から読むため、config を差し替えれば判定が変わる（外部化の確認）。
 */
export function evaluateTop30Gate(inputs: GateTop30Inputs, config: ScoringConfig): GateTop30Result {
  const gate = config.gates.top30;
  const reasons: string[] = [];

  // NaN/±Infinity は `<`/`>` 比較がすべて false になり閾値チェックを素通りするため、
  // 各数値はまず有限性を確認し、不正なら不合格にする（fail-safe）。
  if (!Number.isFinite(inputs.totalForGate)) {
    reasons.push(`TotalForGate が不正な数値（${inputs.totalForGate}）`);
  } else if (inputs.totalForGate < gate.minTotal) {
    reasons.push(`TotalForGate が不足（${inputs.totalForGate} < 必要 ${gate.minTotal}）`);
  }

  if (!Number.isFinite(inputs.confidence)) {
    reasons.push(`confidence が不正な数値（${inputs.confidence}）`);
  } else if (inputs.confidence < gate.minConfidence) {
    reasons.push(`confidence が不足（${inputs.confidence} < 必要 ${gate.minConfidence}）`);
  }

  if (!Number.isFinite(inputs.distinctSourceTypes)) {
    reasons.push(`独立チャネル数が不正な数値（${inputs.distinctSourceTypes}）`);
  } else if (inputs.distinctSourceTypes < gate.minDistinctSources) {
    reasons.push(
      `独立チャネル数が不足（${inputs.distinctSourceTypes} < 必要 ${gate.minDistinctSources}）`,
    );
  }

  if (inputs.testableWithinDays === null) {
    reasons.push("検証手段が未定義（testableWithinDays = null）＝検証可能性ゲート不合格");
  } else if (!Number.isFinite(inputs.testableWithinDays)) {
    reasons.push(`検証までの日数が不正な数値（testableWithinDays = ${inputs.testableWithinDays}）`);
  } else if (inputs.testableWithinDays < 0) {
    reasons.push(
      `検証までの日数が負数で不正（testableWithinDays = ${inputs.testableWithinDays}）`,
    );
  } else if (inputs.testableWithinDays > gate.maxTestDays) {
    reasons.push(
      `検証までの日数が長すぎる（${inputs.testableWithinDays} > 上限 ${gate.maxTestDays}）`,
    );
  }

  return { pass: reasons.length === 0, reasons };
}
