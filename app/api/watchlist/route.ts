// Watchlist API routes（一覧 / 作成）— task-36, spec v2 §9.8。
//
// repository（lib/db/watchlistRepo.ts）を薄く包む App Router の route handler。
// 設計方針（既存 route と同じ流儀）:
// - route handler は repository を呼ぶだけ（ビジネスロジック・Prisma 直呼びは持たない）。
// - 入力検証は repository の Zod（watchlistInputSchema / 列挙）に委ねる。route 側は ZodError を
//   400 へ、想定外を 500 へ翻訳する。返却は常に { data } / { error } の一貫形。
//
// Out of scope: UI（task-37）/ 自動取得（§18.3）。

import { z } from "zod";

import { watchlistRepo, type WatchlistListFilter } from "../../../lib/db/watchlistRepo";
import type { WatchlistInput } from "../../../lib/validation/schemas";

/** ZodError は 400（詳細 issues 付き）、それ以外は 500 に翻訳する共通応答。 */
function errorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: { message: "入力が不正です", issues: error.issues } },
      { status: 400 },
    );
  }
  return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
}

/**
 * GET /api/watchlist — 一覧。
 * クエリ `?entityType=&linkedCandidateId=` を repository.list のフィルタへマップする。
 * 空文字のパラメータは未指定として無視する（不正 enum は repository の Zod が 400 に落とす）。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const sp = new URL(request.url).searchParams;
    const filter: WatchlistListFilter = {};
    const entityType = sp.get("entityType");
    if (entityType) filter.entityType = entityType;
    const linkedCandidateId = sp.get("linkedCandidateId");
    if (linkedCandidateId) filter.linkedCandidateId = linkedCandidateId;

    const data = await watchlistRepo.list(filter);
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/watchlist — 作成。
 * リクエストボディを WatchlistInput として repository に渡す（検証は repository の Zod）。
 * JSON 不正は 400、検証 NG は 400（issues 付き）、成功は 201 で { data }。
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { message: "リクエストボディの JSON が不正です" } },
      { status: 400 },
    );
  }
  try {
    const data = await watchlistRepo.create(body as WatchlistInput);
    return Response.json({ data }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
