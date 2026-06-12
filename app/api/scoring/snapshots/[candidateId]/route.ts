// ScoreSnapshot 履歴 API — task-30, spec v2 §7.5 / §9.9。
//
// GET /api/scoring/snapshots/[candidateId] — 指定 Candidate のスコア推移（ScoreSnapshot）を
// 新しい順で返す。snapshot は saveScores 経由で自動記録される（task-28）ため、ここは履歴を
// 読み出すだけ（snapshotRepo.listByCandidate を薄く包む）。週次の上昇/低下候補（§9.9）や
// CandidateDetail のスコア推移表示（task-31）がこの履歴を使う。
//
// エラー → HTTP の翻訳:
// - candidate が存在しない → 404
// - それ以外               → 500
//
// 成功は 200 で { data: ScoreSnapshot[] }（snapshotAt 降順・id 降順）。
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { candidateRepo } from "../../../../../lib/db/candidateRepo";
import { snapshotRepo } from "../../../../../lib/db/snapshotRepo";

/** 動的セグメント [candidateId] を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ candidateId: string }> };

/**
 * GET /api/scoring/snapshots/[candidateId] — スコア推移を新しい順で返す。
 * 存在しない candidate は 404（空配列と「対象なし」を区別する）。
 */
export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { candidateId } = await ctx.params;
    if ((await candidateRepo.getById(candidateId)) === null) {
      return Response.json({ error: { message: "Candidate が見つかりません" } }, { status: 404 });
    }
    const data = await snapshotRepo.listByCandidate(candidateId);
    return Response.json({ data }, { status: 200 });
  } catch {
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
