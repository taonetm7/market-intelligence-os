// 重複検出 repository — task-34, spec v2 §9.7 / §3.3。
//
// 似た Candidate をサジェストする。類似度の計算自体は純粋関数（lib/duplicate/similarity.ts）に
// 委譲し、この層は「比較対象の取得・素性の構築・除外条件・閾値での絞り込み」を担う。
// UI / API route（task-34 の GET / merge UI は task-35）は Prisma を直接触らず、必ずこの
// repository を経由する。
//
// 設計方針:
// - 除外: 自分自身・rejected・archived は重複候補に含めない（退役/棄却済みを蒸し返さない）。
//   stage の enum 文字列は task-02 の Zod（stageSchema.enum）経由で参照する（直書き禁止）。
// - tags の出所: Candidate に tags カラムは無いため、紐付く RawSignal の signalTags を集約して
//   素性の tags とする（§9.7 の「tags」＝一次シグナルのタグ）。
// - 総当たり: suggestAll は全アクティブ候補の総当たり（O(N^2)）。単一ローカルユーザーで N が小さい
//   前提で許容する。大規模化したら embedding（ベクトル近傍探索）へ移行する＝別タスク（§3.3）。
//
// テスト容易性: 各関数は最後の引数で Prisma クライアントを差し替えられる（既定はシングルトン）。
//
// Out of scope: embedding/ベクトル検索（将来）/ Merge・Split 実行（task-29 を UI から呼ぶのは task-35）。

import { type Candidate, type PrismaClient } from "@prisma/client";

import {
  DEFAULT_THRESHOLD,
  DEFAULT_WEIGHTS,
  similarity,
  type CandidateFeatures,
  type FeatureWeights,
  type FieldMatch,
} from "../duplicate/similarity";
import { stageSchema } from "../validation/enums";
import { parseJsonField } from "../validation/schemas";
import { prisma } from "./client";

/** repository が受け取る Prisma クライアント。 */
export type DuplicateDb = PrismaClient;

/** 重複候補 1 件分（相手の Candidate ＋ 総合スコア ＋ 一致理由）。 */
export interface DuplicateSuggestion {
  /** 似ている相手の Candidate。 */
  candidate: Candidate;
  /** 総合類似度スコア（0〜1）。 */
  score: number;
  /** 一致した項目（「なぜ似ているか」）。類似度降順。 */
  matched: FieldMatch[];
}

/** suggest / suggestAll の任意オプション。 */
export interface DuplicateOptions {
  /** これ以上のスコアを重複候補とする（既定 DEFAULT_THRESHOLD）。 */
  threshold?: number;
  /** 各素性の重み（既定 DEFAULT_WEIGHTS）。 */
  weights?: FeatureWeights;
  /** 返す件数の上限（スコア降順で上位のみ。未指定なら全件）。 */
  limit?: number;
}

/** 重複候補ペア（suggestAll 用。無向ペアを a.score 降順で返す）。 */
export interface DuplicatePair {
  a: Candidate;
  b: Candidate;
  score: number;
  matched: FieldMatch[];
}

/**
 * Candidate ＋ 紐付く RawSignal の signalTags を素性へ変換する。
 * tags は紐付く全 RawSignal の signalTags を集約（重複は similarity 側の正規化で吸収）。
 */
function toFeatures(row: CandidateWithTags): CandidateFeatures {
  const tags: string[] = [];
  for (const evidence of row.evidences) {
    tags.push(...parseJsonField<string[]>(evidence.rawSignal.signalTagsJson, []));
  }
  return {
    problemFamily: row.problemFamily,
    targetUser: row.targetUser,
    contextTrigger: row.contextTrigger,
    painStatement: row.painStatement,
    currentSubstitute: row.currentSubstitute,
    tags,
  };
}

/** findMany の include 形（signalTags の集約に必要な最小列だけを引く）。 */
type CandidateWithTags = Candidate & {
  evidences: { rawSignal: { signalTagsJson: string | null } }[];
};

/** signalTags 集約に必要な include（他列は引かない）。 */
const WITH_TAGS_INCLUDE = {
  evidences: { select: { rawSignal: { select: { signalTagsJson: true } } } },
} as const;

/** 集約用に同梱した evidences を落として素の Candidate へ戻す（API 応答に内部結合を漏らさない）。 */
function stripTags(row: CandidateWithTags): Candidate {
  const { evidences, ...candidate } = row;
  void evidences;
  return candidate;
}

/**
 * rejected / archived を除いたアクティブ Candidate を、signalTags 付きで取得する。
 * enum 文字列は stageSchema.enum 経由で参照する（直書き禁止）。
 */
async function loadActive(db: DuplicateDb): Promise<CandidateWithTags[]> {
  return db.candidate.findMany({
    where: { stage: { notIn: [stageSchema.enum.rejected, stageSchema.enum.archived] } },
    include: WITH_TAGS_INCLUDE,
  });
}

/**
 * 指定 Candidate に似た候補をサジェストする（§9.7）。
 *
 * 対象が存在しない場合は空配列。比較対象は「自分自身・rejected・archived を除く」アクティブ候補。
 * 各候補との総合スコアを求め、`threshold` 以上のものをスコア降順で返す（`limit` で上位 N に絞れる）。
 * `matched` に一致項目（なぜ似ているか）を載せる。対象自身が rejected / archived の場合も空配列
 * （退役/棄却済みからはサジェストしない）。
 */
export async function suggest(
  candidateId: string,
  options: DuplicateOptions = {},
  db: DuplicateDb = prisma,
): Promise<DuplicateSuggestion[]> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const weights = options.weights ?? DEFAULT_WEIGHTS;

  const target = await db.candidate.findUnique({
    where: { id: candidateId },
    include: WITH_TAGS_INCLUDE,
  });
  // 対象が存在しない／退役・棄却済みなら、重複サジェストの対象外（空配列）。
  if (
    target === null ||
    target.stage === stageSchema.enum.rejected ||
    target.stage === stageSchema.enum.archived
  ) {
    return [];
  }

  const targetFeatures = toFeatures(target);
  const others = await loadActive(db);

  const suggestions: DuplicateSuggestion[] = [];
  for (const row of others) {
    if (row.id === candidateId) continue; // 自分自身は除外
    const { score, matched } = similarity(targetFeatures, toFeatures(row), weights);
    if (score >= threshold) {
      suggestions.push({ candidate: stripTags(row), score, matched });
    }
  }

  suggestions.sort((x, y) => y.score - x.score);
  return options.limit === undefined ? suggestions : suggestions.slice(0, options.limit);
}

/**
 * 全アクティブ候補の総当たりで重複ペアを返す（§9.7・重複レビュー一覧の素）。
 *
 * 無向ペア（i < j の組のみ）を `threshold` 以上で抽出し、スコア降順で返す。N が小さい前提の
 * O(N^2)。大規模化したら embedding 近傍探索へ移行する（別タスク・§3.3）。
 */
export async function suggestAll(
  options: DuplicateOptions = {},
  db: DuplicateDb = prisma,
): Promise<DuplicatePair[]> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const weights = options.weights ?? DEFAULT_WEIGHTS;

  const rows = await loadActive(db);
  const features = rows.map(toFeatures);

  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const { score, matched } = similarity(features[i], features[j], weights);
      if (score >= threshold) {
        pairs.push({ a: stripTags(rows[i]), b: stripTags(rows[j]), score, matched });
      }
    }
  }

  pairs.sort((x, y) => y.score - x.score);
  return options.limit === undefined ? pairs : pairs.slice(0, options.limit);
}

/** 重複検出操作の集約 repository。 */
export const duplicateRepo = {
  suggest,
  suggestAll,
};
