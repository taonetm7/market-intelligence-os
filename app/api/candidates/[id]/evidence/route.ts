// Candidate 配下 Evidence 一覧 API — task-21, spec v2 §9.5 / §9.6。
//
// GET /api/candidates/[id]/evidence — 指定 Candidate に紐付く Evidence を新しい順で返す。
// evidenceRepo.listByCandidate（task-10）を薄く包む read-only route。詳細画面
// （CandidateDetail）の Evidence 一覧表示の取得経路。Evidence の作成（link）は
// POST /api/raw-signals/[id]/link-candidate（task-12 / task-22 で UI 起動）、削除は
// DELETE /api/evidence/[id]（task-12）が担い、本 route は読み出し専用。
//
// 存在しない candidate id は 404 にする（「候補が無い」と「Evidence 0 件」を区別する。
// 0 件は 200 で空配列を返す）。返却は既存 API と同じ { data } / { error } 一貫形。
// 成功は 200 で { data: Evidence[] }（listByCandidate のドメイン表現そのまま）。
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { candidateRepo } from "../../../../../lib/db/candidateRepo";
import { evidenceRepo } from "../../../../../lib/db/evidenceRepo";

/** 動的セグメント [id]（= candidateId）を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/candidates/[id]/evidence — 候補に紐付く Evidence 一覧（新しい順）。
 * 候補が存在しなければ 404。存在して証拠 0 件なら 200 で空配列。
 */
export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { id } = await ctx.params;
    // 候補自体の存在を確認する（不在は 404）。証拠 0 件（空配列・200）と区別する。
    if ((await candidateRepo.getById(id)) === null) {
      return Response.json({ error: { message: "Candidate が見つかりません" } }, { status: 404 });
    }
    const data = await evidenceRepo.listByCandidate(id);
    return Response.json({ data }, { status: 200 });
  } catch {
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
