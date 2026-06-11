import type { ScoringConfig } from "./config";

// Top100 進級ゲート — task-05, spec v2 §8.2。
//
// InitialScore（§8.1）を通過した候補が Top100 に進級できるかを、
// config.gates.top100 の閾値で判定する純粋関数。UI の進級可否パネルが使う。
//
// 判定式（§8.2・閾値は config から読む。ハードコード禁止）:
//   InitialScore >= minScore(既定58)
//   ∧ distinctSourceTypes >= minDistinctSources(既定2)   （同一appのレビュー2件=1チャネル）
//   ∧ 強シグナル[spend, dissatisfaction, search] のうち1つ以上
//   ∧ legalRisk <= maxLegalRisk(既定3) ∧ opsRisk <= maxOpsRisk(既定3)
//
// 純粋関数（副作用・外部 I/O・グローバル状態なし）。
//
// Out of scope: Top30 ゲート（task-29）/ confidence 計算（task-06）/
// distinct sourceType の集計（呼び出し側 repository の責務。本関数は数と集合を受けるだけ）。

/** 強シグナルの種別（§8.2）。これらのうち1つ以上を満たすと強シグナル条件を通過。 */
export type StrongSignalType = "spend" | "dissatisfaction" | "search";

/** 強シグナル条件で評価する種別の一覧（reason 生成にも使う）。 */
const STRONG_SIGNAL_TYPES: readonly StrongSignalType[] = ["spend", "dissatisfaction", "search"];

/** Top100 ゲートの入力。素点の検証は呼び出し側の責務（本関数は判定に専念）。 */
export interface GateTop100Inputs {
  /** §8.1 InitialScore（市場デマンド加重和・最大100）。 */
  initialScore: number;
  /** Evidence 由来の distinct な sourceType 数（同一ソースの複数件は1とカウント・§8.2）。 */
  distinctSourceTypes: number;
  /** spend / dissatisfaction / search のうち強シグナルを満たした種別の集合。 */
  strongSignalTypes: ReadonlySet<StrongSignalType>;
  /** 法務・ポリシーリスク（0〜5）。 */
  legalRisk: number;
  /** 運用リスク（0〜5）。 */
  opsRisk: number;
}

/** Top100 ゲートの判定結果。 */
export interface GateTop100Result {
  /** 全条件を満たすと true。 */
  pass: boolean;
  /** 不足条件を人間可読で列挙（全条件満たす場合は空配列）。 */
  reasons: string[];
}

/**
 * Top100 進級ゲートを判定する純粋関数（§8.2）。
 *
 * `config.gates.top100` の閾値（minScore / minDistinctSources / maxLegalRisk / maxOpsRisk）と
 * 強シグナル[spend, dissatisfaction, search] のうち1つ以上、の全条件を満たすかを判定し、
 * `{ pass, reasons }` を返す。`reasons` には満たせなかった条件を人間可読で列挙する
 * （全条件を満たす場合は `[]`）。
 *
 * 閾値はすべて引数の config から読むため、config を差し替えれば判定が変わる（外部化の確認）。
 */
export function evaluateTop100Gate(
  inputs: GateTop100Inputs,
  config: ScoringConfig,
): GateTop100Result {
  const gate = config.gates.top100;
  const reasons: string[] = [];

  if (inputs.initialScore < gate.minScore) {
    reasons.push(`InitialScore が不足（${inputs.initialScore} < 必要 ${gate.minScore}）`);
  }

  if (inputs.distinctSourceTypes < gate.minDistinctSources) {
    reasons.push(
      `独立チャネル数が不足（${inputs.distinctSourceTypes} < 必要 ${gate.minDistinctSources}）`,
    );
  }

  const hasStrongSignal = STRONG_SIGNAL_TYPES.some((type) => inputs.strongSignalTypes.has(type));
  if (!hasStrongSignal) {
    reasons.push("強シグナル（spend / dissatisfaction / search）が1つも立っていない");
  }

  if (inputs.legalRisk > gate.maxLegalRisk) {
    reasons.push(`legalRisk が高すぎる（${inputs.legalRisk} > 上限 ${gate.maxLegalRisk}）`);
  }

  if (inputs.opsRisk > gate.maxOpsRisk) {
    reasons.push(`opsRisk が高すぎる（${inputs.opsRisk} > 上限 ${gate.maxOpsRisk}）`);
  }

  return { pass: reasons.length === 0, reasons };
}
