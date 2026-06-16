// 重複サジェスト抑制 API — task-35 Phase 2, spec v2 §9.7。
//
// POST /api/duplicates/dismiss — Duplicate Review の「Keep Separate / Not Duplicate」を永続化する。
// duplicateDismissalRepo を薄く包むだけ（route は Prisma を直接触らない）。保存後は GET /api/duplicates
// が当該ペアを一覧から除外する（リロード/再訪問・再取得でも復活しない）。
//
// body: { candidateAId, candidateBId, kind: "keep_separate" | "not_duplicate", reason? }
// 返却: { data: { pairKey } } 201。
//
// エラー → HTTP の翻訳:
// - JSON 不正 / 入力検証 NG  → 400
// - それ以外                  → 500

import { z } from "zod";

import {
  duplicateDismissalRepo,
  dismissalKindSchema,
} from "../../../../lib/db/duplicateDismissalRepo";

/** 抑制保存リクエストの検証スキーマ（kind は新規ドメイン enum 経由・直書きしない）。 */
const bodySchema = z.object({
  candidateAId: z.string().min(1),
  candidateBId: z.string().min(1),
  kind: dismissalKindSchema,
  reason: z.string().optional(),
});

/**
 * POST /api/duplicates/dismiss — ペアの抑制を保存する（冪等 upsert）。
 * JSON 不正は 400、検証 NG は 400（issues 付き）、成功は 201 で { data: { pairKey } }。
 */
export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json(
      { error: { message: "リクエストボディの JSON が不正です" } },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: { message: "入力が不正です", issues: parsed.error.issues } },
      { status: 400 },
    );
  }

  try {
    const data = await duplicateDismissalRepo.dismiss(parsed.data);
    return Response.json({ data }, { status: 201 });
  } catch {
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
