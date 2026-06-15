// DecisionLog 履歴 API — task-31, spec v2 §7.6 / §15.2 / §15.3。
//
// GET /api/candidates/[id]/decision-logs — 指定 Candidate の判断ログ（DecisionLog）を
// 新しい順で返す。判断ログは promote / reject / merge / split などの操作時に自動記録される
// （task-29 decisionLogRepo / candidateMerge）ため、ここは履歴を読み出すだけ
// （decisionLogRepo.listByCandidate を薄く包む・ロジックは持たない）。CandidateDetail v2
// （task-31）の判断履歴表示がこの履歴を使う。snapshots route（task-30）と同じ薄い流儀。
//
// エラー → HTTP の翻訳:
// - candidate が存在しない → 404（空配列と「対象なし」を区別する）
// - それ以外               → 500
//
// 成功は 200 で { data: DecisionLog[] }（decidedAt 降順・id 降順）。
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { candidateRepo } from "../../../../../lib/db/candidateRepo";
import { decisionLogRepo } from "../../../../../lib/db/decisionLogRepo";

/** 動的セグメント [id]（= candidateId）を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/candidates/[id]/decision-logs — 判断ログを新しい順で返す。
 * 存在しない candidate は 404（空配列と「対象なし」を区別する）。
 */
export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if ((await candidateRepo.getById(id)) === null) {
      return Response.json({ error: { message: "Candidate が見つかりません" } }, { status: 404 });
    }
    const data = await decisionLogRepo.listByCandidate(id);
    return Response.json({ data }, { status: 200 });
  } catch {
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
