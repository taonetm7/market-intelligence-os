// 重複ペア一覧 API — task-35（Duplicate Review UI）, spec v2 §9.7 / §3.3。
//
// GET /api/duplicates — 全アクティブ候補の総当たりで「似た候補ペア」をスコア降順に返す。
// task-34 の duplicateRepo.suggestAll を薄く包むだけ（route は Prisma を直接触らない／
// 類似度ロジックは持たない）。Duplicate Review 画面（app/duplicates/page.tsx）の取得経路。
//
// クエリ（任意）:
//   ?threshold=0.0〜1.0  この値以上のスコアのペアのみ返す（既定は repository の DEFAULT_THRESHOLD）
//   ?limit=正整数        スコア降順で上位 N ペアに絞る
//
// 返却: { data: DuplicatePair[] }（score 降順）。rejected / archived・自分自身ペアは
//   repository 側で除外される。
//
// エラー → HTTP の翻訳:
// - threshold / limit が不正  → 400
// - それ以外                  → 500

import { z } from "zod";

import { duplicateRepo, type DuplicateOptions } from "../../../lib/db/duplicateRepo";

/** クエリ検証スキーマ（threshold は 0〜1、limit は正整数。未指定は repository の既定に委ねる）。 */
const querySchema = z.object({
  threshold: z.coerce.number().min(0).max(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

/**
 * GET /api/duplicates — 似た候補ペアをスコア降順で返す（重複レビュー一覧の素）。
 * rejected / archived は repository 側で除外される。
 */
export async function GET(request: Request): Promise<Response> {
  try {
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

    const data = await duplicateRepo.suggestAll(options);
    return Response.json({ data }, { status: 200 });
  } catch {
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
