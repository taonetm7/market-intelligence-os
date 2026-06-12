// Evidence link API（link）— task-12, spec v2 §9.6 / §13。
//
// POST /api/raw-signals/[id]/link-candidate — path の [id] = rawSignalId。
// 指定 candidate に RawSignal を Evidence として link する。独立 Evidence 作成は
// 提供しない（link のみ）。route handler は evidenceRepo を薄く包むだけで、Prisma 直呼び
// やビジネスロジックは持たない。
//
// エラー → HTTP の翻訳:
// - ZodError（不正入力）              → 400（issues 付き）
// - rawSignalId / candidateId 不在     → 404
// - EvidenceDuplicateLinkError（重複） → 409（同 candidate/raw/type の二重 link）
// - それ以外                          → 500
//
// 返却は既存 API と同じ { data } / { error } 一貫形。成功時は作成した Evidence と、
// 対象 candidate の signalStatsByCandidate（UI が進級可否を即時更新できる）を返す。
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す（task-11 に倣う）。

import { z } from "zod";

import { candidateRepo } from "../../../../../lib/db/candidateRepo";
import {
  EvidenceDuplicateLinkError,
  evidenceRepo,
} from "../../../../../lib/db/evidenceRepo";
import { rawSignalRepo } from "../../../../../lib/db/rawSignalRepo";
import { evidenceLinkInputSchema } from "../../../../../lib/validation/schemas";

/** 動的セグメント [id]（= rawSignalId）を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ id: string }> };

/** ZodError → 400、重複 link → 409、それ以外 → 500 に翻訳する共通応答。 */
function errorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: { message: "入力が不正です", issues: error.issues } },
      { status: 400 },
    );
  }
  if (error instanceof EvidenceDuplicateLinkError) {
    return Response.json(
      { error: { message: "同一の証拠種別で既に紐付け済みです" } },
      { status: 409 },
    );
  }
  return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
}

/**
 * POST /api/raw-signals/[id]/link-candidate — RawSignal を Candidate に link。
 * body は { candidateId, evidenceType, strength, credibility? }。path の [id] を
 * rawSignalId として注入し EvidenceLinkInput で検証する（不正 JSON / 検証 NG は 400）。
 * rawSignalId / candidateId が存在しなければ 404、二重 link は 409、成功は 201 で
 * { data: { evidence, stats } }。
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { id: rawSignalId } = await ctx.params;
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
    // path の rawSignalId を注入して検証（enum / 素点は task-02 の Zod スキーマ経由）。
    const input = evidenceLinkInputSchema.parse({
      ...(body as Record<string, unknown>),
      rawSignalId,
    });

    // 一次ソース（RawSignal）と Candidate の存在を確認する（不在は 404）。
    if ((await rawSignalRepo.getById(input.rawSignalId)) === null) {
      return Response.json(
        { error: { message: "RawSignal が見つかりません" } },
        { status: 404 },
      );
    }
    if ((await candidateRepo.getById(input.candidateId)) === null) {
      return Response.json(
        { error: { message: "Candidate が見つかりません" } },
        { status: 404 },
      );
    }

    const evidence = await evidenceRepo.link(input);
    const stats = await evidenceRepo.signalStatsByCandidate(input.candidateId);
    return Response.json(
      {
        data: {
          evidence,
          // strongSignalTypes は Set。JSON 化のため配列へ変換する。
          stats: { ...stats, strongSignalTypes: [...stats.strongSignalTypes] },
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
