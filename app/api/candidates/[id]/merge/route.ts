// Candidate 統合 API — task-30, spec v2 §15.2 / §15.3。
//
// POST /api/candidates/[id]/merge — path の [id] = survivorId（残す側）。
// body { absorbedId, reason } の吸収側を survivor へ統合する。意味論本体（Evidence /
// ScoreSnapshot / DecisionLog の re-parent・吸収側 archived・両者へ merge ログ）は task-29 の
// candidateMerge.merge に委譲し、route は入力検証と前提条件のエラー → HTTP 翻訳だけを行う。
//
// candidateMerge.merge は前提条件違反を Error で投げる（reason 空 / 生存側＝吸収側 / 候補不在 /
// 吸収側が既に archived）。これらを呼び出し前に API 層で先に弾いて明確な 4xx に翻訳する
// （merge 内部でも同じガードがあり、二重に防ぐ）:
// - ZodError（absorbedId 欠落 / reason 空白のみ）→ 400
// - survivorId === absorbedId                    → 400（自分自身とは統合できない）
// - survivor / absorbed が存在しない             → 404
// - 吸収側が既に archived（統合済み）            → 409
// - それ以外                                     → 500
//
// 成功は 200 で { data: MergeResult }（re-parent 件数等のサマリ）。
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { z } from "zod";

import { candidateRepo } from "../../../../../lib/db/candidateRepo";
import { candidateMerge } from "../../../../../lib/db/candidateMerge";
import { stageSchema } from "../../../../../lib/validation/enums";

/** 動的セグメント [id]（= survivorId）を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ id: string }> };

/** merge リクエスト body。吸収側 ID（必須）と判断理由（必須・空白のみは弾く・§15.3）。 */
const mergeBodySchema = z.object({
  absorbedId: z.string().min(1),
  reason: z.string().trim().min(1),
});

/**
 * POST /api/candidates/[id]/merge — [id] を survivor として absorbedId を統合する。
 * 入力検証と前提条件を API 層で先に弾いてから candidateMerge.merge を呼ぶ。
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
    const { absorbedId, reason } = mergeBodySchema.parse(body);

    // 自分自身とは統合できない（merge 内部でも弾くが、明確な 400 を返すため先に判定する）。
    if (id === absorbedId) {
      return Response.json(
        { error: { message: "生存側と吸収側が同一の候補です（自分自身とは統合できません）" } },
        { status: 400 },
      );
    }

    // 両者の存在と吸収側の状態を先に確認し、明確な 4xx に翻訳する。
    const survivor = await candidateRepo.getById(id);
    if (survivor === null) {
      return Response.json(
        { error: { message: "生存側の Candidate が見つかりません" } },
        { status: 404 },
      );
    }
    const absorbed = await candidateRepo.getById(absorbedId);
    if (absorbed === null) {
      return Response.json(
        { error: { message: "吸収側の Candidate が見つかりません" } },
        { status: 404 },
      );
    }
    if (absorbed.stage === stageSchema.enum.archived) {
      return Response.json(
        { error: { message: "吸収側は既に archived です（統合済み）。再統合はできません" } },
        { status: 409 },
      );
    }

    const data = await candidateMerge.merge({ survivorId: id, absorbedId, reason });
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
