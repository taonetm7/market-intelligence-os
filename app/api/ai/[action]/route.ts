// AI 下書き提案 API — task-39, spec v2 §11.1 / §11.2。
//
// POST /api/ai/[action] — 指定アクションの **proposed（提案）だけ** を返す。
//   action: tag-suggest | normalize-draft | missing-evidence | research-prompt。
// この route は **DB を一切変更しない**（repository を import しない＝書き込み経路が無い）。
// 実体（RawSignal / Evidence）への反映は task-15 quarantine→人間 accept を別途通す。
//
// API キー未設定時は **エラーにせず** 200 で { data: { enabled: false } } を返す（任意機能・§11）。
//
// エラー → HTTP の翻訳:
// - 未知 action                       → 404
// - ZodError（入力不正 / 不正 JSON）   → 400
// - AiResponseError / AiRequestError   → 502（上流 AI 由来の失敗）
// - それ以外                          → 500
// 成功は 200 で { data: proposal }（proposal.origin === "ai"）。
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す（task-12 に倣う）。

import { z } from "zod";

import { AiRequestError } from "../../../../lib/ai/client";
import { isAiEnabled } from "../../../../lib/ai/client";
import { AiResponseError, aiActionSchema, runAiAction } from "../../../../lib/ai/suggest";

/** 動的セグメント [action] を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ action: string }> };

/** エラー → HTTP の翻訳（400 / 502 / 500）。 */
function errorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: { message: "入力が不正です", issues: error.issues } },
      { status: 400 },
    );
  }
  if (error instanceof AiResponseError || error instanceof AiRequestError) {
    return Response.json({ error: { message: error.message } }, { status: 502 });
  }
  return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
}

/**
 * POST /api/ai/[action] — AI 下書き提案を返す（proposed のみ・DB 非変更）。
 * 未知 action は 404。API キー未設定は 200 で { data: { enabled: false } }。
 * 不正 JSON / 入力検証 NG は 400、上流 AI 失敗は 502、成功は 200 で { data: proposal }。
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { action: rawAction } = await ctx.params;
  const parsedAction = aiActionSchema.safeParse(rawAction);
  if (!parsedAction.success) {
    return Response.json(
      { error: { message: `未知の AI アクションです: ${rawAction}` } },
      { status: 404 },
    );
  }

  // 任意機能: キー未設定なら握り潰して無効応答（エラーにしない・他機能を壊さない）。
  if (!isAiEnabled()) {
    return Response.json(
      { data: { enabled: false, reason: "ANTHROPIC_API_KEY が未設定のため AI 機能は無効です" } },
      { status: 200 },
    );
  }

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
    const proposal = await runAiAction(parsedAction.data, body);
    return Response.json({ data: proposal }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
