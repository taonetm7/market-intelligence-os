// AI 下書き提案（draft→accept）— task-39, spec v2 §11.1 / §11.2 / §8.9。
//
// 4 アクション: タグ候補 / 正規化下書き / 不足 Evidence 提案 / Deep Research プロンプト生成。
// いずれも **proposed（提案）だけ** を返す純粋関数群で、DB を一切触らない。実体（RawSignal /
// Evidence）への反映は task-15 quarantine→人間 accept を必ず通す（ここでは作らない）。
//
// 厳守（§11.2）:
// - 全出力に origin="ai"（originSchema 経由。直書きしない）。
// - **スコア素点 / Evidence strength / stage は AI 提案不可**。出力スキーマにこれらのフィールドを
//   持たせないことで「AI が score/stage を動かす経路」を構造的に塞ぐ（モデルが幻覚で返しても
//   zod が未知キーとして落とす）。
//
// 設計:
// - Claude 往復は client.ts の AiComplete に委譲（DI 既定 = defaultComplete）。テストは偽 complete を渡す。
// - 不足 Evidence の算出は task-32 の evidenceTypeCoverage を再利用（重複定義しない）。

import { z } from "zod";

import { evidenceTypeCoverage } from "../export/deepResearch";
import { evidenceTypeSchema, originSchema, sourceTypeSchema } from "../validation/enums";
import { defaultComplete, type AiComplete } from "./client";

/** AI アクション識別子（route の [action] セグメントに対応）。ドメイン enum ではないので route-local。 */
export const AI_ACTION_VALUES = [
  "tag-suggest",
  "normalize-draft",
  "missing-evidence",
  "research-prompt",
] as const;
export const aiActionSchema = z.enum(AI_ACTION_VALUES);
export type AiAction = z.infer<typeof aiActionSchema>;

/** 全提案に付く来歴（§11.2）。"ai" は originSchema 経由で取得し直書きしない。 */
const AI_ORIGIN = originSchema.enum.ai;

/** 提案の共通ラッパ。proposed は各アクション固有の形。origin は常に "ai"。 */
export interface AiProposal<T> {
  origin: typeof AI_ORIGIN;
  action: AiAction;
  proposed: T;
}

/** AI 応答（テキスト）が JSON として解釈できないときのエラー（route 側で 502 に翻訳）。 */
export class AiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiResponseError";
  }
}

// ---------------------------------------------------------------------------
// 入力スキーマ（各アクション）
// ---------------------------------------------------------------------------

const tagSuggestInputSchema = z.object({
  text: z.string().min(1),
  observedEntity: z.string().optional(),
  sourceType: sourceTypeSchema.optional(),
});
export type TagSuggestInput = z.input<typeof tagSuggestInputSchema>;

const normalizeDraftInputSchema = z.object({
  rawText: z.string().min(1),
  sourceType: sourceTypeSchema.optional(),
  observedEntity: z.string().optional(),
});
export type NormalizeDraftInput = z.input<typeof normalizeDraftInputSchema>;

const missingEvidenceInputSchema = z.object({
  // 既に link 済みの evidenceType（想定外文字列は coverage 算出側で無視される）。
  presentEvidenceTypes: z.array(z.string()).default([]),
  title: z.string().optional(),
  painStatement: z.string().optional(),
});
export type MissingEvidenceInput = z.input<typeof missingEvidenceInputSchema>;

const researchPromptInputSchema = z.object({
  title: z.string().min(1),
  targetUser: z.string().optional(),
  painStatement: z.string().optional(),
  currentSubstitute: z.string().optional(),
  presentEvidenceTypes: z.array(z.string()).default([]),
});
export type ResearchPromptInput = z.input<typeof researchPromptInputSchema>;

// ---------------------------------------------------------------------------
// 出力スキーマ（各アクション）
// score / stage / strength を一切持たない（構造的に AI へ確定権を与えない）。
// zod は既定で未知キーを落とすため、モデルが score 等を返しても proposed には現れない。
// ---------------------------------------------------------------------------

const tagSuggestOutputSchema = z.object({
  tags: z.array(z.string().min(1)).max(20).default([]),
});
export type TagSuggestProposal = z.infer<typeof tagSuggestOutputSchema>;

const normalizeDraftOutputSchema = z.object({
  title: z.string(),
  targetUser: z.string().optional(),
  painStatement: z.string().optional(),
  currentSubstitute: z.string().optional(),
});
export type NormalizeDraftProposal = z.infer<typeof normalizeDraftOutputSchema>;

const missingEvidenceOutputSchema = z.object({
  // 不足 type と「どう探すか」のヒントのみ。strength は持たせない（人間が link 時に決める）。
  suggestions: z
    .array(
      z.object({
        evidenceType: evidenceTypeSchema,
        hint: z.string(),
      }),
    )
    .default([]),
});
export type MissingEvidenceProposal = z.infer<typeof missingEvidenceOutputSchema>;

const researchPromptOutputSchema = z.object({
  prompt: z.string(),
});
export type ResearchPromptProposal = z.infer<typeof researchPromptOutputSchema>;

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

/** 全アクション共通の system 前文。スコア/stage/strength を出さないことを厳命する。 */
const SYSTEM_PREAMBLE =
  "あなたは新規事業の市場調査を支援するアシスタントです。" +
  "出力は必ず指定された JSON オブジェクトだけにし、前後に説明文やコードフェンスを付けないでください。" +
  "スコア（素点）、Evidence の strength、stage（進級ステージ）は絶対に出力しないでください。" +
  "これらは人間だけが確定します。";

/** モデルのテキスト応答から JSON オブジェクトを取り出して parse する（コードフェンス除去込み）。 */
function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  // ```json ... ``` のフェンスを剥がす。
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new AiResponseError("AI 応答を JSON として解釈できませんでした");
  }
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    throw new AiResponseError("AI 応答の JSON parse に失敗しました");
  }
}

/** proposed を origin="ai" でラップする。 */
function wrap<T>(action: AiAction, proposed: T): AiProposal<T> {
  return { origin: AI_ORIGIN, action, proposed };
}

// ---------------------------------------------------------------------------
// 4 アクション
// ---------------------------------------------------------------------------

/** タグ候補を提案する（signalTags の下書き）。proposed のみ・DB 非変更。 */
export async function tagSuggest(
  input: TagSuggestInput,
  complete: AiComplete = defaultComplete,
): Promise<AiProposal<TagSuggestProposal>> {
  const { text, observedEntity, sourceType } = tagSuggestInputSchema.parse(input);
  const prompt = [
    "次の一次観測に付与すべき短いタグ候補を最大10個、JSON で提案してください。",
    'スキーマ: {"tags": string[]}',
    sourceType ? `ソース種別: ${sourceType}` : null,
    observedEntity ? `観測対象: ${observedEntity}` : null,
    `観測内容: ${text}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const raw = await complete({ system: SYSTEM_PREAMBLE, prompt });
  const proposed = tagSuggestOutputSchema.parse(parseJsonObject(raw));
  return wrap("tag-suggest", proposed);
}

/** RawSignal から Candidate 正規化フィールドの下書きを提案する。score/stage は含めない。 */
export async function normalizeDraft(
  input: NormalizeDraftInput,
  complete: AiComplete = defaultComplete,
): Promise<AiProposal<NormalizeDraftProposal>> {
  const { rawText, sourceType, observedEntity } = normalizeDraftInputSchema.parse(input);
  const prompt = [
    "次の一次観測を、候補（Candidate）の正規化フィールド下書きに変換してください。",
    'スキーマ: {"title": string, "targetUser"?: string, "painStatement"?: string, "currentSubstitute"?: string}',
    "スコア・stage は出力しないでください（人間が後で決めます）。",
    sourceType ? `ソース種別: ${sourceType}` : null,
    observedEntity ? `観測対象: ${observedEntity}` : null,
    `観測内容: ${rawText}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const raw = await complete({ system: SYSTEM_PREAMBLE, prompt });
  const proposed = normalizeDraftOutputSchema.parse(parseJsonObject(raw));
  return wrap("normalize-draft", proposed);
}

/**
 * 不足している Evidence type を提案する。不足集合は task-32 の evidenceTypeCoverage で
 * 決定的に算出し、その範囲に対してモデルに調査ヒントを書かせる（strength は出させない）。
 */
export async function missingEvidence(
  input: MissingEvidenceInput,
  complete: AiComplete = defaultComplete,
): Promise<AiProposal<MissingEvidenceProposal>> {
  const { presentEvidenceTypes, title, painStatement } =
    missingEvidenceInputSchema.parse(input);
  const { missing } = evidenceTypeCoverage(presentEvidenceTypes);

  // 不足が無ければモデルを呼ばず空提案（コスト節約・決定的）。
  if (missing.length === 0) {
    return wrap("missing-evidence", missingEvidenceOutputSchema.parse({ suggestions: [] }));
  }

  const prompt = [
    "次の候補について、不足している Evidence をどう集めるかのヒントを JSON で提案してください。",
    'スキーマ: {"suggestions": [{"evidenceType": string, "hint": string}]}',
    `evidenceType は次のいずれかのみ: ${missing.join(", ")}`,
    "strength（証拠の強さ）は出力しないでください（人間が link 時に決めます）。",
    title ? `候補: ${title}` : null,
    painStatement ? `痛み: ${painStatement}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const raw = await complete({ system: SYSTEM_PREAMBLE, prompt });
  const parsed = missingEvidenceOutputSchema.parse(parseJsonObject(raw));
  // 念のため、不足集合に含まれない type の提案は捨てる（経路の堅牢化）。
  const allowed = new Set<string>(missing);
  const suggestions = parsed.suggestions.filter((s) => allowed.has(s.evidenceType));
  return wrap("missing-evidence", { suggestions });
}

/** Deep Research 用プロンプト（Markdown）を生成する。proposed テキストのみ。 */
export async function researchPrompt(
  input: ResearchPromptInput,
  complete: AiComplete = defaultComplete,
): Promise<AiProposal<ResearchPromptProposal>> {
  const parsed = researchPromptInputSchema.parse(input);
  const { missing } = evidenceTypeCoverage(parsed.presentEvidenceTypes);
  const prompt = [
    "次の候補について、一次ソース（URL）付きで追加調査を依頼する Deep Research プロンプトを生成してください。",
    'スキーマ: {"prompt": string}（prompt は Markdown 文字列）',
    "不足 Evidence を中心に調べる指示を含めてください。スコア・stage は出力しないでください。",
    `候補: ${parsed.title}`,
    parsed.targetUser ? `対象ユーザー: ${parsed.targetUser}` : null,
    parsed.painStatement ? `痛み: ${parsed.painStatement}` : null,
    parsed.currentSubstitute ? `現代替手段: ${parsed.currentSubstitute}` : null,
    missing.length > 0 ? `不足 Evidence: ${missing.join(", ")}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const raw = await complete({ system: SYSTEM_PREAMBLE, prompt });
  const proposed = researchPromptOutputSchema.parse(parseJsonObject(raw));
  return wrap("research-prompt", proposed);
}

// ---------------------------------------------------------------------------
// dispatch（route から使う）
// ---------------------------------------------------------------------------

/**
 * action に応じて対応する suggest 関数へ振り分ける。入力検証は各関数内の zod が担う
 * （不正入力は ZodError）。DB は一切触らない。
 */
export async function runAiAction(
  action: AiAction,
  body: unknown,
  complete: AiComplete = defaultComplete,
): Promise<AiProposal<unknown>> {
  switch (action) {
    case "tag-suggest":
      return tagSuggest(body as TagSuggestInput, complete);
    case "normalize-draft":
      return normalizeDraft(body as NormalizeDraftInput, complete);
    case "missing-evidence":
      return missingEvidence(body as MissingEvidenceInput, complete);
    case "research-prompt":
      return researchPrompt(body as ResearchPromptInput, complete);
  }
}
