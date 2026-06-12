// RawSignal import API（quarantine 投入）— task-15, spec v2 §10.1 / §13 Slice 1。
//
// POST /api/raw-signals/import — JSON / CSV を受け取り、task-14 のパーサで検証し、
// valid/invalid とも quarantine（隔離テーブル）へ投入する。即本登録はしない（§10.1 step4）。
// 本登録は accept（POST /api/imports/[batchId]/accept）で人間が承認したときだけ行う。
//
// 設計方針:
// - route handler は parse（task-14）と quarantineRepo（task-15）を薄く包むだけ。
// - 入力の format / origin / content は route-local の Zod で検証する（task-02 の共有
//   スキーマは変更しない）。origin は enum を直書きせず originSchema 派生を使う。
// - 返却は既存 API と同じ { data } / { error } 一貫形。成功は 201。
//
// body 形:
//   { format: "json" | "csv", content: string | object, origin?: "import" | "ai", note?: string }
//   - json: content は §10.1 エンベロープ（オブジェクト or 文字列）。
//   - csv:  content は固定ヘッダ CSV 文字列。

import { z } from "zod";

import { parseCsv, parseJson, type ParseResult } from "../../../../lib/import/parse";
import {
  batchOriginSchema,
  BATCH_FORMAT_VALUES,
  quarantineRepo,
} from "../../../../lib/import/quarantineRepo";

/** import リクエストボディの検証スキーマ（route-local）。 */
const importRequestSchema = z.object({
  format: z.enum(BATCH_FORMAT_VALUES),
  // json は文字列 or 既パース済みオブジェクト、csv は文字列を受ける（parser が両対応）。
  content: z.union([z.string(), z.record(z.string(), z.unknown())]),
  origin: batchOriginSchema.optional(),
  note: z.string().optional(),
});

/** ZodError は 400（issues 付き）、それ以外は 500 に翻訳する共通応答。 */
function errorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: { message: "入力が不正です", issues: error.issues } },
      { status: 400 },
    );
  }
  return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
}

/**
 * POST /api/raw-signals/import — import 行を quarantine へ投入する。
 * format に応じて parseJson / parseCsv で検証し、valid/invalid とも隔離する。
 * JSON ボディ不正は 400、検証 NG は 400（issues 付き）、成功は 201 で
 * { data: { batch, pending, invalid } }。
 */
export async function POST(request: Request): Promise<Response> {
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
    const { format, content, origin, note } = importRequestSchema.parse(body);

    // csv は文字列必須（オブジェクトは受け付けない）。json は文字列/オブジェクト両対応。
    let parsed: ParseResult;
    if (format === "csv") {
      if (typeof content !== "string") {
        return Response.json(
          { error: { message: "csv の content は文字列で渡してください" } },
          { status: 400 },
        );
      }
      parsed = parseCsv(content);
    } else {
      parsed = parseJson(content);
    }

    const result = await quarantineRepo.createBatchFromParse(parsed, {
      origin,
      format,
      note,
    });
    return Response.json({ data: result }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
