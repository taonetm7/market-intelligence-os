// Candidate 分割 API — task-30, spec v2 §15.2 / §15.3。
//
// POST /api/candidates/[id]/split — path の [id] = sourceId（分割元）。
// body { evidenceIds, reason, title? } で、元候補の複製を1件生成し、指定 Evidence を新候補へ移す。
// 意味論本体（複製生成・Evidence 移送・split ログ）は task-29 の candidateMerge.split に委譲し、
// route は入力検証と前提条件のエラー → HTTP 翻訳だけを行う。
//
// エラー → HTTP の翻訳:
// - ZodError（reason 空白のみ / evidenceIds 不正）→ 400
// - 分割元 source が存在しない                     → 404
// - それ以外                                       → 500
//
// 成功は 200 で { data: SplitResult }（新候補 ID・移送 Evidence 件数）。
// 指定 Evidence のうち元候補に属さないものは candidateMerge.split が無視する（誤って他候補の
// Evidence を奪わない）ため、movedEvidence が evidenceIds.length 未満になり得る。
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { z } from "zod";

import { candidateRepo } from "../../../../../lib/db/candidateRepo";
import { candidateMerge } from "../../../../../lib/db/candidateMerge";

/** 動的セグメント [id]（= sourceId）を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ id: string }> };

/**
 * split リクエスト body。新候補へ移す Evidence の id 群（既定 []）・判断理由（必須・空白のみは
 * 弾く・§15.3）・任意の新候補タイトル上書き。
 */
const splitBodySchema = z.object({
  evidenceIds: z.array(z.string().min(1)).default([]),
  reason: z.string().trim().min(1),
  title: z.string().min(1).optional(),
});

/**
 * POST /api/candidates/[id]/split — [id] を source として複製を生成し、指定 Evidence を移す。
 * 入力検証と前提条件を API 層で先に弾いてから candidateMerge.split を呼ぶ。
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
    const { evidenceIds, reason, title } = splitBodySchema.parse(body);

    // 分割元の存在を先に確認し、明確な 404 を返す（split 内部でも弾く）。
    if ((await candidateRepo.getById(id)) === null) {
      return Response.json(
        { error: { message: "分割元の Candidate が見つかりません" } },
        { status: 404 },
      );
    }

    const data = await candidateMerge.split({ sourceId: id, evidenceIds, reason, title });
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: { message: "入力が不正です", issues: error.issues } },
        { status: 400 },
      );
    }
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
