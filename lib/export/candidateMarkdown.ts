// Candidate の Markdown export — task-32, spec v2 §10.2。
//
// 候補（基本情報・Evidence・スコア・リスク・次アクション）を、人間/AI 往復用の Markdown 文字列へ
// 変換する純粋関数。DB/Prisma には依存せず、必要なフィールドだけを受ける構造的な入力型を取る
// （CandidateRecord / Evidence + RawSignal がそのまま渡せる形）。副作用は持たず、I/O は呼び出し側
// （API route task-32）の責務。
//
// §10.2 テンプレート:
//   # Candidate: {title}
//   ## 対象ユーザー / 状況 / 痛み / 現代替手段
//   ## Evidence（type・strength・sourceUrl）
//   ## スコア（initial/detailed/confidence/distinctSources）
//   ## リスク / 次アクション
//
// enum 文字列（evidenceType 等）は直書きせず、表示はソースの値をそのまま反映する（採点・判定は
// しないため enum 検証は不要。値はリポジトリ層で検証済み）。

/** Markdown 化に必要な候補フィールド（CandidateRecord の部分集合・構造的に受ける）。 */
export interface MarkdownCandidate {
  title: string;
  displayId?: string | null;
  problemFamily?: string | null;
  targetUser?: string | null;
  contextTrigger?: string | null;
  painStatement?: string | null;
  currentSubstitute?: string | null;
  spendType?: string | null;
  monetizationGuess?: string | null;
  productFormFit?: string[] | null;
  initialScore?: number | null;
  detailedScore?: number | null;
  confidence?: number | null;
  founderFit?: number | null;
  buildEase?: number | null;
  legalRisk?: number | null;
  opsRisk?: number | null;
  nextAction?: string | null;
}

/**
 * Markdown 化に必要な Evidence フィールド（Evidence + 紐付く RawSignal の薄い射影）。
 * sourceType は distinctSources（§9.4 一次ソース種別数）の算出に使う。
 */
export interface MarkdownEvidence {
  evidenceType: string;
  strength: number;
  sourceType?: string | null;
  sourceName?: string | null;
  sourceUrl?: string | null;
}

/** null/undefined/空文字を "—" に畳む（テキスト項目の整形）。 */
function text(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "—";
}

/** スコア（0〜5 など）を小数 1 桁へ。未設定（null）は "—"。 */
function num(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(1);
}

/** confidence（0〜1）を「0.42」表記へ。未設定は "—"。 */
function conf(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(2);
}

/**
 * 一次ソース種別の異なり数（§9.4 distinctSources）。Evidence に紐付く RawSignal.sourceType を
 * 重複排除して数える（sourceType 不明の証拠は数えない）。
 */
export function distinctSources(evidence: readonly MarkdownEvidence[]): number {
  const types = new Set<string>();
  for (const e of evidence) {
    if (e.sourceType) types.add(e.sourceType);
  }
  return types.size;
}

/** Evidence 1 件を 1 行へ（type・strength・sourceUrl を併記。§10.2）。 */
function evidenceLine(e: MarkdownEvidence): string {
  const url = e.sourceUrl?.trim();
  const where = url && url.length > 0 ? url : "（sourceUrl なし）";
  const name = e.sourceName?.trim();
  const suffix = name && name.length > 0 ? ` — ${name}` : "";
  return `- ${e.evidenceType}（strength ${e.strength}）: ${where}${suffix}`;
}

/**
 * 候補 + Evidence を §10.2 テンプレートの Markdown 文字列へ変換する（純粋関数）。
 * 見出し構成はテンプレ固定。値が無い項目は "—"、Evidence 0 件は「（Evidence なし）」を出す。
 */
export function candidateToMarkdown(
  candidate: MarkdownCandidate,
  evidence: readonly MarkdownEvidence[] = [],
): string {
  const heading = candidate.displayId
    ? `# Candidate: ${candidate.displayId} ${candidate.title}`
    : `# Candidate: ${candidate.title}`;

  const forms =
    candidate.productFormFit && candidate.productFormFit.length > 0
      ? candidate.productFormFit.join(" / ")
      : "—";

  const evidenceLines =
    evidence.length > 0 ? evidence.map(evidenceLine).join("\n") : "（Evidence なし）";

  const lines = [
    heading,
    "",
    "## 対象ユーザー / 状況 / 痛み / 現代替手段",
    `- 対象ユーザー: ${text(candidate.targetUser)}`,
    `- 状況・トリガー: ${text(candidate.contextTrigger)}`,
    `- 痛み: ${text(candidate.painStatement)}`,
    `- 現代替手段: ${text(candidate.currentSubstitute)}`,
    `- 支出形態: ${text(candidate.spendType)}`,
    `- 想定収益: ${text(candidate.monetizationGuess)}`,
    `- 課題ファミリ: ${text(candidate.problemFamily)}`,
    `- 想定プロダクト形態: ${forms}`,
    "",
    "## Evidence（type・strength・sourceUrl）",
    evidenceLines,
    "",
    "## スコア（initial / detailed / confidence / distinctSources）",
    `- 初期スコア: ${num(candidate.initialScore)}`,
    `- 詳細スコア: ${num(candidate.detailedScore)}`,
    `- 確信度: ${conf(candidate.confidence)}`,
    `- 一次ソース種別数: ${distinctSources(evidence)}`,
    "",
    "## リスク / 次アクション",
    `- 法務リスク: ${num(candidate.legalRisk)}`,
    `- 運用リスク: ${num(candidate.opsRisk)}`,
    `- 開発容易性: ${num(candidate.buildEase)}`,
    `- 創業者適合: ${num(candidate.founderFit)}`,
    `- 次アクション: ${text(candidate.nextAction)}`,
    "",
  ];
  return lines.join("\n");
}
