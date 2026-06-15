// Candidate 重複サジェスト API — task-34, spec v2 §9.7 / §3.3。
//
// GET /api/candidates/[id]/duplicates — 指定 Candidate に似た候補をサジェストする。
// 類似度は文字列/タグ類似（embedding は §3.3 で初期版対象外）。ビジネスロジックは持たず、
// duplicateRepo を薄く包むだけ（route は Prisma を直接触らない方針）。
//
// クエリ（任意）:
//   ?threshold=0.0〜1.0  この値以上のスコアのみ返す（既定は repository の DEFAULT_THRESHOLD）
//   ?limit=正整数        スコア降順で上位 N 件に絞る
//
// 返却: { data: DuplicateSuggestion[] }（score 降順）。対象が存在しない／退役・棄却済みなら
//   duplicateRepo.suggest が空配列を返す（404 にはしない＝「似た候補なし」と同義に扱う）。
//
// エラー → HTTP の翻訳:
// - threshold / limit が不正            → 400
// - それ以外                            → 500
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { z } from "zod";

import { duplicateRepo, type DuplicateOptions } from "../../../../../lib/db/duplicateRepo";

/** 動的セグメント [id]（= candidateId）を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ id: string }> };

/** クエリ検証スキーマ（threshold は 0〜1、limit は正整数。未指定は repository の既定に委ねる）。 */
const querySchema = z.object({
  threshold: z.coerce.number().min(0).max(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

/**
 * GET /api/candidates/[id]/duplicates — 似た候補をスコア降順でサジェスト。
 * 自分自身・rejected・archived は repository 側で除外される。
 */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const { searchParams } = new URL(request.url);

    const parsed = querySchema.safeParse({
      threshold: searchParams.get("threshold") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return Response.json(
        { error: { message: "クエリが不正です", issues: parsed.error.issues } },
        { status: 400 },
      );
    }

    const options: DuplicateOptions = {};
    if (parsed.data.threshold !== undefined) options.threshold = parsed.data.threshold;
    if (parsed.data.limit !== undefined) options.limit = parsed.data.limit;

    const data = await duplicateRepo.suggest(id, options);
    return Response.json({ data }, { status: 200 });
  } catch {
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
