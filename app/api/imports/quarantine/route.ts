// Quarantine 一覧 API — task-15, spec v2 §10.1 step5 / §13 Slice 1。
//
// GET /api/imports/quarantine — 隔離一覧。batch 単位で pending / invalid / accepted を
// 束ねて返す（人間が確認 → accept / reject を判断するための一覧 UI 用・task-23）。
// クエリ `?batchId=` で 1 バッチに絞れる。
//
// 設計方針:
// - route handler は quarantineRepo.listQuarantine を薄く包むだけ。
// - 返却は既存 API と同じ { data } / { error } 一貫形。成功は 200。

import { quarantineRepo } from "../../../../lib/import/quarantineRepo";

/**
 * GET /api/imports/quarantine — 隔離一覧（batch 単位）。
 * `?batchId=` 指定時はそのバッチのみ。成功は 200 で
 * { data: [{ batch, pending, invalid, accepted }, ...] }。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const batchId = new URL(request.url).searchParams.get("batchId") ?? undefined;
    const data = await quarantineRepo.listQuarantine(batchId);
    return Response.json({ data }, { status: 200 });
  } catch {
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
