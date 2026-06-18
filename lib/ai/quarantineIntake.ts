// AI 提案 → quarantine(origin=ai) 投入ブリッジ — task-39 Phase 2, spec v2 §11.2。
//
// 背景（Codex 指摘①）: AI 提案（proposed）を実体（RawSignal）へ反映する経路は、§11.2 により
// **必ず task-15 quarantine（origin="ai"）→ 人間 accept** を通さねばならない。AI 提案を直接
// RawSignal へ書く経路は持たない。本モジュールはその「呼び出し側」だけを担い、隔離・accept の
// 本体（task-15 quarantineRepo / parse）は **無改変で再利用** する（重複定義・本体改変をしない）。
//
// 注意: lib/ai/suggest.ts と app/api/ai/[action]/route.ts は提案専用（DB 非変更）のまま据え置く。
// 本モジュールはそれらから import されない（提案 route が DB 書込経路を持たない構造を保つため）。
// 実行時は import UI（既存 POST /api/raw-signals/import の origin="ai"）と本ブリッジが入口になる。

import { prisma } from "../db/client";
import { parseJson } from "../import/parse";
import {
  quarantineRepo,
  type QuarantineDb,
  type QuarantineImportResult,
} from "../import/quarantineRepo";
import { originSchema } from "../validation/enums";

/** AI 由来データの来歴。直書きせず originSchema 経由（§11.2 / enum 直書き禁止）。 */
const AI_ORIGIN = originSchema.enum.ai;

/**
 * AI 由来の RawSignal 下書き（人間が確認・編集した後の値）を quarantine へ投入する。
 *
 * - 既存 import パーサ（parseJson）で 1 行ずつ検証し、valid/invalid とも隔離する（失敗行を捨てない）。
 * - batch の origin を **"ai"** に固定して焼き込むため、accept で本登録される RawSignal には
 *   必ず origin="ai" が付く（§11.2 の監査要件）。RawSignal は accept で初めて作られる
 *   （ここでは作らない＝人間 accept の関門を必ず通す）。
 *
 * @param drafts AI 提案を反映した RawSignal 下書き（§10.1 の import 形。tags 別名も可）。
 * @param db     テスト用に差し替え可能な Prisma クライアント（既定はシングルトン）。
 */
export async function submitAiRawSignalsToQuarantine(
  drafts: unknown[],
  db: QuarantineDb = prisma,
): Promise<QuarantineImportResult> {
  const parsed = parseJson({ rawSignals: drafts });
  return quarantineRepo.createBatchFromParse(parsed, { origin: AI_ORIGIN, format: "json" }, db);
}
