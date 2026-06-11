// Confidence（証拠の確からしさ・0〜1）— task-06, spec v2 §8.6。
//
// 「未定義の0〜1値」ではなく、観測量（distinct な sourceType 数・証拠強度・
// 直接支出証拠の有無・新しさ）から算出する confidence。擬似科学化を防ぎ、
// Top30 ゲート（Slice 2）と2軸ビューの基盤になる純粋関数。
//
// 計算式（§8.6）:
//   confidence = 0.4 * min(distinctSourceTypes / 3, 1)
//              + 0.3 * (avgEvidenceStrength / 5)
//              + 0.2 * hasDirectSpendEvidence
//              + 0.1 * recencyFactor
//   出力は [0, 1] にクランプする。
//
// 純粋関数（同入力→同出力・外部 I/O・グローバル状態なし）。
//
// Out of scope: Top30 ゲートでの使用（Slice 2・task-29）/ recency の DB 取得
//   （呼び出し側が recencyFactor を 0〜1 に正規化して渡す。本関数は計算に専念）。

// 各項の重み係数（§8.6）。合計 1.0。
// config 化候補: Slice 1 では関数内定数。将来 scoring.config.json へ外部化しうる
//   （初期較正後に再重み付けする可能性があるため。task-03 ScoringConfig 参照）。
const WEIGHT_DISTINCT_SOURCES = 0.4;
const WEIGHT_EVIDENCE_STRENGTH = 0.3;
const WEIGHT_DIRECT_SPEND = 0.2;
const WEIGHT_RECENCY = 0.1;

// 正規化の基準値（§8.6）。distinct source は 3 種で頭打ち、証拠強度は 0〜5。
const DISTINCT_SOURCES_SATURATION = 3;
const EVIDENCE_STRENGTH_MAX = 5;

/** Confidence の入力。各値の検証・正規化は呼び出し側の責務。 */
export interface ConfidenceInputs {
  /** Evidence 由来の distinct な sourceType 数（同一ソースの複数件は1とカウント・§8.2/§8.6）。 */
  distinctSourceTypes: number;
  /** 証拠強度の平均（0〜5）。 */
  avgEvidenceStrength: number;
  /** 直接的な支出証拠があれば 1、なければ 0。 */
  hasDirectSpendEvidence: 0 | 1;
  /** 新しさ係数（0〜1）。呼び出し側が経過日数等から正規化して渡す。 */
  recencyFactor: number;
}

/** 値を [min, max] にクランプする。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 観測量から confidence（0〜1）を算出する純粋関数（§8.6）。
 *
 * `0.4*min(distinctSourceTypes/3,1) + 0.3*(avgEvidenceStrength/5)
 *  + 0.2*hasDirectSpendEvidence + 0.1*recencyFactor` を計算し、結果を [0, 1] にクランプする。
 *
 * 各項も内部で正規化・クランプするため、入力が想定範囲（distinct≥0 /
 * strength 0〜5 / recency 0〜1）を多少外れても出力は [0, 1] に収まる。
 * ただし素点の妥当性検証は呼び出し側（入力層）の責務。
 */
export function computeConfidence(inputs: ConfidenceInputs): number {
  // distinct source は 3 種で寄与が頭打ち（min(.../3, 1)）。負値は 0 に切り上げ。
  const distinctTerm = clamp(inputs.distinctSourceTypes / DISTINCT_SOURCES_SATURATION, 0, 1);
  // 証拠強度は 0〜5 を 0〜1 に正規化。
  const strengthTerm = clamp(inputs.avgEvidenceStrength / EVIDENCE_STRENGTH_MAX, 0, 1);
  // 直接支出証拠は 0 / 1 のフラグ。
  const spendTerm = clamp(inputs.hasDirectSpendEvidence, 0, 1);
  // 新しさ係数は 0〜1。
  const recencyTerm = clamp(inputs.recencyFactor, 0, 1);

  const confidence =
    WEIGHT_DISTINCT_SOURCES * distinctTerm +
    WEIGHT_EVIDENCE_STRENGTH * strengthTerm +
    WEIGHT_DIRECT_SPEND * spendTerm +
    WEIGHT_RECENCY * recencyTerm;

  // 各項を [0,1] にクランプ済みかつ重み合計=1 なので理論上 [0,1] だが、
  // 浮動小数誤差に備えて最終クランプする。
  return clamp(confidence, 0, 1);
}
