// Quarantine accept API（本登録）— task-15, spec v2 §10.1 step5 / §11.2 / §13 Slice 1。
//
// POST /api/imports/[batchId]/accept — 選択された pending 行のみを RawSignal へ本登録する。
// invalid 行は accept 不可（§10.1: 失敗行は本登録できない）。本登録される RawSignal には
// batch の origin（import | ai）が付く（§11.2: AI 由来は origin="ai"）。
//
// エラー → HTTP の翻訳:
// - ZodError（不正入力）                 → 400（issues 付き）
// - QuarantineNotFoundError（batch/行不在）→ 404
// - QuarantineInvalidRowError（invalid を accept）→ 409
// - QuarantineAlreadyAcceptedError（再 accept）   → 409
// - それ以外                            → 500
//
// 返却は既存 API と同じ { data } / { error } 一貫形。成功は 201 で
// { data: { accepted, snapshot } }（snapshot は §18.4 auto-snapshot 最小実装の件数記録）。
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す（task-12 に倣う）。

import { z } from "zod";

import {
  QuarantineAlreadyAcceptedError,
  QuarantineInvalidRowError,
  QuarantineNotFoundError,
  quarantineRepo,
} from "../../../../../lib/import/quarantineRepo";

/** 動的セグメント [batchId] を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ batchId: string }> };

/** accept リクエストボディ（route-local）。rowIds 省略時はバッチの pending 全行が対象。 */
const acceptRequestSchema = z.object({
  rowIds: z.array(z.string()).optional(),
});

/** エラー → HTTP の翻訳（404 / 409 / 400 / 500）。 */
function errorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: { message: "入力が不正です", issues: error.issues } },
      { status: 400 },
    );
  }
  if (error instanceof QuarantineNotFoundError) {
    return Response.json({ error: { message: error.message } }, { status: 404 });
  }
  if (error instanceof QuarantineInvalidRowError) {
    return Response.json(
      { error: { message: "invalid な隔離行は本登録できません", rowIds: error.rowIds } },
      { status: 409 },
    );
  }
  if (error instanceof QuarantineAlreadyAcceptedError) {
    return Response.json(
      { error: { message: "既に本登録済みの隔離行は再 accept できません", rowIds: error.rowIds } },
      { status: 409 },
    );
  }
  return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
}

/**
 * POST /api/imports/[batchId]/accept — 選択 pending 行を RawSignal へ本登録。
 * body は { rowIds?: string[] }（省略時は pending 全行）。invalid 行が含まれれば 409、
 * batch / 行が無ければ 404、成功は 201 で { data: { accepted, snapshot } }。
 * 空ボディも許容する（pending 全行 accept とみなす）。
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { batchId } = await ctx.params;

  // 空ボディ（Content-Length 0）も許容: その場合は pending 全行 accept とする。
  let body: unknown = {};
  const text = await request.text();
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json(
        { error: { message: "リクエストボディの JSON が不正です" } },
        { status: 400 },
      );
    }
  }

  try {
    const { rowIds } = acceptRequestSchema.parse(body);
    const data = await quarantineRepo.accept(batchId, rowIds);
    return Response.json({ data }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
