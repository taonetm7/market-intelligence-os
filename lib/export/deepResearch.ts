// Deep Research 用 export — task-32, spec v2 §10.3。
//
// 候補の「不足している Evidence」を evidenceType カバレッジから自動算出し、AI への追加調査依頼
// プロンプト（Markdown）を生成する純粋関数。AI 往復（§11.1 不足 Evidence 提案 / Deep Research
// プロンプト生成）の入口。
//
// 中核は「想定 evidenceType 集合（§7.4 の全種別）」と「実 link 済み type」の差分:
//   present = 想定集合 ∩ 実 link 済み
//   missing = 想定集合 − 実 link 済み
// 想定集合は task-02 の EVIDENCE_TYPE_VALUES を正本として参照する（直書きせず・将来の種別追加に
// 自動追従する）。

import { EVIDENCE_TYPE_VALUES, type EvidenceType } from "../validation/enums";

/** evidenceType カバレッジ（想定集合に対する present / missing の差分）。 */
export interface EvidenceTypeCoverage {
  /** 実際に link 済みの想定 evidenceType（EVIDENCE_TYPE_VALUES の並び順を保つ）。 */
  present: EvidenceType[];
  /** まだ link されていない想定 evidenceType（自動算出の本体）。 */
  missing: EvidenceType[];
}

/**
 * evidenceType の人間向けラベル（§10.3 の調査観点に対応）。
 * キーは EvidenceType の全値で、型（Record<EvidenceType, string>）が網羅を保証する
 * （種別追加時はここがコンパイルエラーになり追従漏れを防ぐ）。
 */
export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  spend: "既存支出の有無",
  dissatisfaction: "競合・代替への不満",
  search: "検索需要",
  community: "コミュニティでの言及",
  outsourcing: "外注・テンプレ市場",
  job: "求人シグナル",
  regulation: "法務・規制",
  founder: "創業者シグナル",
};

/**
 * link 済み evidenceType 集合から present / missing を算出する（純粋関数）。
 * 想定集合は EVIDENCE_TYPE_VALUES（§7.4）を正本にし、その並び順で返す（決定的）。
 * 入力に想定外の文字列が混じっても無視する（想定集合との積/差だけを見る）。
 */
export function evidenceTypeCoverage(linkedTypes: Iterable<string>): EvidenceTypeCoverage {
  const linked = new Set<string>(linkedTypes);
  const present: EvidenceType[] = [];
  const missing: EvidenceType[] = [];
  for (const type of EVIDENCE_TYPE_VALUES) {
    if (linked.has(type)) {
      present.push(type);
    } else {
      missing.push(type);
    }
  }
  return { present, missing };
}

/** Deep Research プロンプトに載せる候補概要（CandidateRecord の部分集合）。 */
export interface DeepResearchCandidate {
  title: string;
  displayId?: string | null;
  targetUser?: string | null;
  painStatement?: string | null;
  currentSubstitute?: string | null;
}

/** null/空文字を "—" に畳む。 */
function text(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "—";
}

/** 「spend（既存支出の有無）」のように type とラベルを併記する。 */
function labelLine(type: EvidenceType): string {
  return `- ${type}（${EVIDENCE_TYPE_LABELS[type]}）`;
}

/**
 * 候補 + link 済み evidenceType から §10.3 の Deep Research プロンプト Markdown を生成する。
 * 不足 Evidence は evidenceTypeCoverage で自動算出して列挙する（差分が本機能の主眼）。
 * linkedTypes は Evidence の evidenceType の集まり（重複していてもよい）。
 */
export function candidateToDeepResearch(
  candidate: DeepResearchCandidate,
  linkedTypes: Iterable<string>,
): string {
  const { present, missing } = evidenceTypeCoverage(linkedTypes);
  const who = candidate.displayId ? `${candidate.displayId} ${candidate.title}` : candidate.title;

  const presentBlock =
    present.length > 0 ? present.map(labelLine).join("\n") : "（まだ Evidence がありません）";
  const missingBlock =
    missing.length > 0 ? missing.map(labelLine).join("\n") : "（不足している Evidence はありません）";

  const lines = [
    "以下の候補について追加調査してください。",
    "",
    "## 候補概要",
    `- 候補: ${who}`,
    `- 対象ユーザー: ${text(candidate.targetUser)}`,
    `- 痛み: ${text(candidate.painStatement)}`,
    `- 現代替手段: ${text(candidate.currentSubstitute)}`,
    "",
    "## 現在あるEvidence（type別）",
    presentBlock,
    "",
    "## 不足しているEvidence（自動算出）",
    missingBlock,
    "",
    "## 調査してほしいこと",
    "- 上記の不足 Evidence を中心に、一次ソース（URL）付きで観測を集めてください。",
    "- 観点: 既存支出の有無 / 競合不満 / 検索需要 / 外注・テンプレ市場 / 法務リスク",
    "",
  ];
  return lines.join("\n");
}
