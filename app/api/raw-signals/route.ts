// RawSignal API routes（一覧 / 作成）— task-11, spec v2 §13 Slice 1。
//
// repository（lib/db/rawSignalRepo.ts）を薄く包む App Router の route handler。
// 設計方針:
// - route handler は repository を呼ぶだけ（ビジネスロジックは持たない）。
// - 入力検証は repository の Zod（rawSignalInputSchema / 列挙）に委ねる。route 側は
//   その ZodError を 400 へ、想定外を 500 へ翻訳する（エラー型 → HTTP の翻訳責務）。
// - 返却は常に { data } / { error } の一貫形。ステータスは 200/201/400/500 を使い分ける。
//
// Out of scope: import（task-15）/ link-candidate（task-12）。

import { z } from "zod";

import { rawSignalRepo, type RawSignalListFilter } from "../../../lib/db/rawSignalRepo";
import type { RawSignalInput } from "../../../lib/validation/schemas";

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
 * GET /api/raw-signals — 一覧。
 * クエリ `?sourceType=&status=&unlinked=1&q=` を repository.list のフィルタへマップする。
 * 空文字のパラメータは未指定として無視する（不正 enum は repository の Zod が 400 に落とす）。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const sp = new URL(request.url).searchParams;
    const filter: RawSignalListFilter = {};
    const sourceType = sp.get("sourceType");
    if (sourceType) filter.sourceType = sourceType;
    const status = sp.get("status");
    if (status) filter.status = status;
    const q = sp.get("q");
    if (q) filter.q = q;
    const unlinked = sp.get("unlinked");
    if (unlinked === "1" || unlinked === "true") filter.unlinkedOnly = true;

    const data = await rawSignalRepo.list(filter);
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/raw-signals — 作成。
 * リクエストボディを RawSignalInput として repository に渡す（検証は repository の Zod）。
 * JSON として不正なボディは 400、検証 NG は 400（issues 付き）、成功は 201 で { data }。
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
    const data = await rawSignalRepo.create(body as RawSignalInput);
    return Response.json({ data }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
