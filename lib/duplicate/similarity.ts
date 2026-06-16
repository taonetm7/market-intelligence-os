// Candidate 類似度（重複検出の素性）— task-34, spec v2 §9.7 / §3.3。
//
// 似た Candidate をサジェストするための「どれくらい似ているか」を計算する純粋関数。
// §9.7 の判定項目（problemFamily / targetUser / contextTrigger / painStatement /
// currentSubstitute / tags）をすべて素性に使い、各項目の類似度の加重和を返す。
//
// 設計方針:
// - 純粋関数（副作用・I/O・グローバル状態なし）。DB アクセスは duplicateRepo の責務。
// - テキスト項目は「正規化文字列の文字 2-gram（バイグラム）Jaccard」で比較する。
//   日本語は語境界（空白）が無く単純なトークン分割が効かないため、文字 n-gram を用いると
//   日英どちらでも頑健に部分一致を捉えられる（FTS5 の trigram と同じ理由・task-33）。
//   完全一致の正規化文字列は Jaccard=1.0 になる（n-gram 集合が一致するため）。
// - tags は離散トークンのため、正規化タグ集合の Jaccard で比較する。
// - スコアは [0,1]。両側とも空の項目は分母から除外する（情報の無い項目で薄めない）。
//   片側だけ空なら類似度 0 として分母に算入する（欠落は非一致として扱う）。
//
// Out of scope: embedding/ベクトル類似（§3.3 初期版では入れない。大規模化時に別タスク）。

/** §9.7 の判定項目を素性化した Candidate の比較用ビュー。テキストは null 可、tags は配列。 */
export interface CandidateFeatures {
  problemFamily: string | null;
  targetUser: string | null;
  contextTrigger: string | null;
  painStatement: string | null;
  currentSubstitute: string | null;
  /** 紐付く RawSignal の signalTags を集約したもの（duplicateRepo が構築する）。 */
  tags: string[];
}

/** 比較に用いるテキスト項目のキー（tags 以外の §9.7 項目）。 */
export const TEXT_FEATURE_KEYS = [
  "problemFamily",
  "targetUser",
  "contextTrigger",
  "painStatement",
  "currentSubstitute",
] as const;
export type TextFeatureKey = (typeof TEXT_FEATURE_KEYS)[number];

/** 全素性キー（テキスト 5 項目 ＋ tags）。 */
export type FeatureKey = TextFeatureKey | "tags";

/** 各素性の重み（加重和の係数）。problemFamily / painStatement を厚めにする（§9.7 の核）。 */
export type FeatureWeights = Record<FeatureKey, number>;

/** 既定の重み。problemFamily（同一問題か）と painStatement（同じ痛みか）を最重視する。 */
export const DEFAULT_WEIGHTS: FeatureWeights = {
  problemFamily: 3,
  painStatement: 3,
  targetUser: 2,
  contextTrigger: 2,
  currentSubstitute: 2,
  tags: 2,
};

/** 総合スコアがこの値以上なら「重複候補」とみなす既定閾値。 */
export const DEFAULT_THRESHOLD = 0.4;

/** ある素性を「一致した項目（理由）」として挙げる個別類似度の下限。 */
export const MATCH_FIELD_THRESHOLD = 0.5;

/** 「なぜ似ているか」を構成する 1 項目分の一致情報。 */
export interface FieldMatch {
  /** 一致した素性キー。 */
  field: FeatureKey;
  /** その素性の個別類似度（0〜1）。 */
  similarity: number;
}

/** 2 候補の類似度判定の結果。 */
export interface SimilarityResult {
  /** 加重和による総合スコア（0〜1）。 */
  score: number;
  /** MATCH_FIELD_THRESHOLD 以上で一致した項目（類似度降順）＝「なぜ似ているか」。 */
  matched: FieldMatch[];
}

/**
 * テキスト正規化: NFKC 正規化 → 小文字化 → 前後空白除去 → 連続空白を 1 個へ畳む。
 * 全角/半角・大小文字・余分な空白の揺れを吸収する。
 */
export function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

/** 正規化済み文字列の文字 2-gram 集合。長さ 1 以下なら文字列自身を 1 要素とする。 */
function bigrams(normalized: string): Set<string> {
  if (normalized.length <= 1) {
    return normalized.length === 0 ? new Set() : new Set([normalized]);
  }
  const grams = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    grams.add(normalized.slice(i, i + 2));
  }
  return grams;
}

/** 2 集合の Jaccard 係数（|∩| / |∪|）。両方空なら 0。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * テキスト 2 項目の類似度（0〜1）。正規化後の文字 2-gram Jaccard。
 * 完全一致は 1.0、無関係はおおむね 0 に近づく。両方空文字なら 0。
 */
export function textSimilarity(a: string | null, b: string | null): number {
  const na = normalizeText(a ?? "");
  const nb = normalizeText(b ?? "");
  if (na === "" && nb === "") return 0;
  return jaccard(bigrams(na), bigrams(nb));
}

/** タグ集合の正規化（NFKC 小文字化・空タグ除去・重複排除）。 */
function normalizeTags(tags: string[]): Set<string> {
  const set = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeText(tag);
    if (normalized !== "") set.add(normalized);
  }
  return set;
}

/**
 * タグ 2 集合の類似度（0〜1）。正規化タグ集合の Jaccard。両方空なら 0。
 */
export function tagSimilarity(a: string[], b: string[]): number {
  return jaccard(normalizeTags(a), normalizeTags(b));
}

/** テキスト項目が（正規化後に）内容を持つか。両側空の項目は分母から除外するために使う。 */
function hasText(value: string | null): boolean {
  return normalizeText(value ?? "") !== "";
}

/**
 * 2 候補の類似度を判定する純粋関数（§9.7）。
 *
 * 各素性（テキスト 5 項目＋tags）の個別類似度を求め、重みで加重平均して総合スコアを返す。
 * 両側とも内容が無い項目は分母から除外する（情報の無い項目でスコアを薄めない）。どの項目にも
 * 内容が無ければスコア 0。`matched` には個別類似度が MATCH_FIELD_THRESHOLD 以上の項目を
 * 類似度降順で載せ、「なぜ似ているか」の説明にする。
 */
export function similarity(
  a: CandidateFeatures,
  b: CandidateFeatures,
  weights: FeatureWeights = DEFAULT_WEIGHTS,
): SimilarityResult {
  const perField: FieldMatch[] = [];
  let weightedSum = 0;
  let weightTotal = 0;

  for (const key of TEXT_FEATURE_KEYS) {
    // 両側空の項目はスキップ（分母にも入れない）。片側だけ空なら類似度 0 で算入する。
    if (!hasText(a[key]) && !hasText(b[key])) continue;
    const sim = textSimilarity(a[key], b[key]);
    weightedSum += weights[key] * sim;
    weightTotal += weights[key];
    perField.push({ field: key, similarity: sim });
  }

  // tags は両側空（どちらもタグ無し）なら寄与させない。
  if (a.tags.length > 0 || b.tags.length > 0) {
    const sim = tagSimilarity(a.tags, b.tags);
    weightedSum += weights.tags * sim;
    weightTotal += weights.tags;
    perField.push({ field: "tags", similarity: sim });
  }

  const score = weightTotal === 0 ? 0 : weightedSum / weightTotal;
  const matched = perField
    .filter((m) => m.similarity >= MATCH_FIELD_THRESHOLD)
    .sort((x, y) => y.similarity - x.similarity);

  return { score, matched };
}
