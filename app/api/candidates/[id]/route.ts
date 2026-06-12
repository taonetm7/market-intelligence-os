// Candidate API routes（取得 / 更新 / 削除）— task-13, spec v2 §8 / §13 / §15.1。
//
// 単一 Candidate を id で操作する route handler。route.ts と同じく repository を薄く
// 包むだけで、ビジネスロジックは持たない。
//
// DELETE の意味（重要）: Candidate は hard delete しない（§7.3 / §15.1 履歴保全:
//   Evidence / ScoreSnapshot / DecisionLog を破壊しないため）。candidateRepo に delete は
//   無く、DELETE は `setStage("archived")` によるソフト退役として実装する（route は
//   Prisma を直接触らず repository を薄く包む方針を保つ）。棄却（rejected）は理由コード
//   必須のため別経路（POST /reject）。
//
// エラー → HTTP の翻訳:
// - ZodError（不正入力）        → 400（issues 付き）
// - getById が null            → 404
// - Prisma P2025（対象行なし）  → 404（update / setStage の存在しない id）
// - それ以外                    → 500
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { candidateRepo, type CandidateUpdate } from "../../../../lib/db/candidateRepo";

/** id が指す Candidate が存在しないときの共通 404 ボディ。 */
const NOT_FOUND_BODY = { error: { message: "Candidate が見つかりません" } } as const;

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

/** GET /api/candidates/[id] — 1 件取得。存在しなければ 404。 */
export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const data = await candidateRepo.getById(id);
    if (data === null) {
      return Response.json(NOT_FOUND_BODY, { status: 404 });
    }
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * PUT /api/candidates/[id] — 部分更新。
 * ボディを CandidateUpdate として repository に渡す（検証は repository の Zod）。省略フィールドは
 * 変更しない。派生スコアはこのパスでは変更できない（saveScores 専用）。`stage='rejected'` への
 * 遷移は不可（§15.1: reject 経由のみ）。不正 JSON / 検証 NG は 400、存在しない id は 404、成功は 200。
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
    const data = await candidateRepo.update(id, body as CandidateUpdate);
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * DELETE /api/candidates/[id] — ソフト退役（stage を archived にする）。
 * hard delete はしない（履歴保全・§7.3 / §15.1）。存在しない id は 404（P2025）、成功は 200 で
 * 退役後の { data }（stage='archived'）。
 */
export async function DELETE(_request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const data = await candidateRepo.setStage(id, "archived");
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
