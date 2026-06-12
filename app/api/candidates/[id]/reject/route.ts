// Candidate 棄却 API — task-13, spec v2 §8.9 / §15.1。
//
// POST /api/candidates/[id]/reject — path の [id] = candidateId。
// candidateRepo.reject を薄く包むだけ。棄却は理由コード（rejectedReasonCode）必須
// （§15.1 傾向分析）で、stage を rejected に固定する。コード無し（未指定・不正値）は
// repository の Zod が弾く＝棄却できない。自由文 rejectedReason は任意の補足。
//
// エラー → HTTP の翻訳:
// - ZodError（reasonCode 未指定 / 不正）→ 400（issues 付き）
// - Prisma P2025（対象行なし）          → 404（存在しない id）
// - それ以外                            → 500
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { candidateRepo, type CandidateReject } from "../../../../../lib/db/candidateRepo";

/** ZodError → 400、Prisma P2025 → 404、それ以外 → 500 に翻訳する共通応答。 */
function errorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: { message: "入力が不正です", issues: error.issues } },
      { status: 400 },
    );
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
    return Response.json(
      { error: { message: "Candidate が見つかりません" } },
      { status: 404 },
    );
  }
  return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
}

/** 動的セグメント [id]（= candidateId）を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/candidates/[id]/reject — 棄却。
 * body は { rejectedReasonCode, rejectedReason? }。path の [id] を id として注入し
 * candidateRepo.reject に渡す（検証は repository の Zod。reasonCode 必須）。
 * 不正 JSON / 検証 NG は 400、存在しない id は 404、成功は 200 で { data }（stage='rejected'）。
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
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
    // path の id を注入して reject（reasonCode は task-02 の Zod スキーマ経由で検証）。
    const input = { ...(body as Record<string, unknown>), id } as CandidateReject;
    const data = await candidateRepo.reject(input);
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
