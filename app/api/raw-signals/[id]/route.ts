// RawSignal API routes（取得 / 更新 / 削除）— task-11, spec v2 §13 Slice 1。
//
// 単一 RawSignal を id で操作する route handler。route.ts と同じく repository を薄く
// 包むだけで、ビジネスロジックは持たない。
// エラー → HTTP の翻訳:
// - ZodError（不正入力）        → 400（issues 付き）
// - getById が null            → 404
// - Prisma P2025（対象行なし）  → 404（update / delete の存在しない id）
// - それ以外                    → 500
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { rawSignalRepo, type RawSignalUpdate } from "../../../../lib/db/rawSignalRepo";

/** id が指す RawSignal が存在しないときの共通 404 ボディ。 */
const NOT_FOUND_BODY = { error: { message: "RawSignal が見つかりません" } } as const;

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

/** GET /api/raw-signals/[id] — 1 件取得。存在しなければ 404。 */
export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const data = await rawSignalRepo.getById(id);
    if (data === null) {
      return Response.json(NOT_FOUND_BODY, { status: 404 });
    }
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * PUT /api/raw-signals/[id] — 部分更新。
 * ボディを RawSignalUpdate として repository に渡す（検証は repository の Zod）。
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
    const data = await rawSignalRepo.update(id, body as RawSignalUpdate);
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * DELETE /api/raw-signals/[id] — 削除。
 * 成功は 200 で { data: { id } }（一貫形を保つ）、存在しない id は 404（P2025）。
 */
export async function DELETE(_request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { id } = await ctx.params;
    await rawSignalRepo.delete(id);
    return Response.json({ data: { id } }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
