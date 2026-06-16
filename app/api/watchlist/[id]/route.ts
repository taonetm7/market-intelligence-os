// Watchlist API routes（取得 / 更新 / 値更新 / 削除）— task-36, spec v2 §9.8。
//
// 単一 Watchlist を id で操作する route handler。route.ts と同じく repository を薄く包むだけ。
// メソッドの役割:
// - GET    : 1 件取得
// - PUT    : 任意フィールドの部分更新（メタ情報の編集）
// - PATCH  : updateValue 導線（手動入力の新値で current→last へシフト＋差分算出）
// - DELETE : 削除
//
// エラー → HTTP の翻訳:
// - ZodError（不正入力）        → 400（issues 付き）
// - getById が null            → 404
// - Prisma P2025（対象行なし）  → 404（update / updateValue / delete の存在しない id）
// - それ以外                    → 500
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { candidateRepo } from "../../../../lib/db/candidateRepo";
import { watchlistRepo, type WatchlistUpdate } from "../../../../lib/db/watchlistRepo";

/** id が指す Watchlist が存在しないときの共通 404 ボディ。 */
const NOT_FOUND_BODY = { error: { message: "Watchlist が見つかりません" } } as const;

/**
 * linkedCandidateId が **非空文字列で指定** されていれば紐付け先 Candidate の存在を先に確認する
 * （route.ts の POST と同様式）。不在なら「紐付け先の Candidate が見つかりません」404 を返す
 * （Watchlist 自体の不在 404 と区別する）。未指定（null/undefined）は確認不要で null を返す。
 * 空文字 "" は watchlistInputSchema 由来の .min(1) が 400 で弾くため、ここでは素通しして後段の parse に委ねる。
 */
async function linkedCandidateNotFound(linkedCandidateId: unknown): Promise<Response | null> {
  if (typeof linkedCandidateId !== "string" || linkedCandidateId === "") return null;
  if ((await candidateRepo.getById(linkedCandidateId)) === null) {
    return Response.json(
      { error: { message: "紐付け先の Candidate が見つかりません" } },
      { status: 404 },
    );
  }
  return null;
}

/** ZodError → 400、Prisma P2025 → 404、それ以外 → 500 に翻訳する共通応答。 */
function errorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: { message: "入力が不正です", issues: error.issues } },
      { status: 400 },
    );
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
    return Response.json(NOT_FOUND_BODY, { status: 404 });
  }
  return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
}

/** 動的セグメント [id] を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ id: string }> };

/** PATCH の値更新ボディ（手動入力の新値）。 */
const patchSchema = z.object({ value: z.string().min(1) });

/** GET /api/watchlist/[id] — 1 件取得。存在しなければ 404。 */
export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const data = await watchlistRepo.getById(id);
    if (data === null) {
      return Response.json(NOT_FOUND_BODY, { status: 404 });
    }
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * PUT /api/watchlist/[id] — 部分更新（メタ情報の編集）。
 * 不正 JSON / 検証 NG は 400、存在しない id は 404（P2025）、成功は 200 で { data }。
 */
export async function PUT(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params;
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
    // path エンティティ（Watchlist）→ 紐付け先（Candidate）の順で存在確認し、両 404 を区別する。
    // Watchlist 不在は「Watchlist が見つかりません」、candidate 不在は専用メッセージ（FK 500 でなく 404）。
    if ((await watchlistRepo.getById(id)) === null) {
      return Response.json(NOT_FOUND_BODY, { status: 404 });
    }
    const notFound = await linkedCandidateNotFound(
      (body as { linkedCandidateId?: unknown }).linkedCandidateId,
    );
    if (notFound !== null) return notFound;

    const data = await watchlistRepo.update(id, body as WatchlistUpdate);
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * PATCH /api/watchlist/[id] — 値更新（updateValue 導線）。
 * body { value } の新値で current→last へシフトし deltaFlag を算出する。
 * 不正 JSON / value 欠落は 400、存在しない id は 404（P2025）、成功は 200 で { data }。
 */
export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { message: "リクエストボディの JSON が不正です" } },
      { status: 400 },
    );
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: { message: "入力が不正です", issues: parsed.error.issues } },
      { status: 400 },
    );
  }
  try {
    const data = await watchlistRepo.updateValue(id, parsed.data.value);
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * DELETE /api/watchlist/[id] — 削除。
 * 成功は 200 で { data: { id } }（一貫形）、存在しない id は 404（P2025）。
 */
export async function DELETE(_request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { id } = await ctx.params;
    await watchlistRepo.delete(id);
    return Response.json({ data: { id } }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
