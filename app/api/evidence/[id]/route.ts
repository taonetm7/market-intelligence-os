// Evidence unlink API（削除）— task-12, spec v2 §9.6 / §13。
//
// DELETE /api/evidence/[id] — Evidence（link）を 1 件削除して unlink する。
// route handler は evidenceRepo.unlink を薄く包むだけ。独立 Evidence の作成・更新は
// 提供しない（証拠は付け外しで表現する）。
//
// エラー → HTTP の翻訳:
// - Prisma P2025（対象行なし）  → 404（存在しない id の unlink）
// - それ以外                    → 500
//
// 返却は既存 API と同じ { data } / { error } 一貫形。成功は 200 で { data: { id } }。
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { Prisma } from "@prisma/client";

import { evidenceRepo } from "../../../../lib/db/evidenceRepo";

/** 動的セグメント [id]（= evidenceId）を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ id: string }> };

/** DELETE /api/evidence/[id] — unlink。成功は 200 で { data: { id } }、存在しない id は 404。 */
export async function DELETE(_request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { id } = await ctx.params;
    await evidenceRepo.unlink(id);
    return Response.json({ data: { id } }, { status: 200 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return Response.json(
        { error: { message: "Evidence が見つかりません" } },
        { status: 404 },
      );
    }
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
