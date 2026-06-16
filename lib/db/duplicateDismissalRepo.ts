// 重複サジェスト抑制 repository — task-35 Phase 2, spec v2 §9.7。
//
// Duplicate Review 画面で「Keep Separate / Not Duplicate」と判断したペアを永続化し、
// 重複サジェスト一覧（GET /api/duplicates）から恒久的に除外する（リロード/再訪問・再取得で
// 復活させない＝task 定義「抑制フラグ保存」）。
//
// 設計方針:
// - ペアは無向。2 候補 ID を整列・結合した安定キー pairKey で一意化する（左右の順序に依らない）。
// - dismiss は upsert（同じペアを再度抑制しても 1 行・冪等）。kind は app 層（Zod）で検証する。
// - 類似度・サジェスト本体は持たない（task-34 の責務）。ここは抑制の保存と参照のみ。
// - 各関数は最後の引数で Prisma クライアントを差し替えられる（既定はシングルトン）。
//
// Out of scope: 類似度計算（task-34）/ merge・split 実体（task-29/30）。

import { type PrismaClient } from "@prisma/client";
import { z } from "zod";

import { prisma } from "./client";

/** repository が受け取る Prisma クライアント。 */
export type DuplicateDismissalDb = PrismaClient;

/** 抑制の種別（Keep Separate / Not Duplicate）。新規ドメイン enum のためここを正本とする。 */
export const DISMISSAL_KIND_VALUES = ["keep_separate", "not_duplicate"] as const;
export const dismissalKindSchema = z.enum(DISMISSAL_KIND_VALUES);
export type DismissalKind = z.infer<typeof dismissalKindSchema>;

/** 抑制保存の入力。reason は任意（理由メモ）。 */
export interface DismissInput {
  candidateAId: string;
  candidateBId: string;
  kind: DismissalKind;
  reason?: string;
}

/**
 * 無向ペアの安定キー。2 候補 ID を整列・結合する（左右の順序に依らず一意）。
 * クライアント側（DuplicatePairCard.pairKey）と同一規約。
 */
export function normalizePairKey(candidateAId: string, candidateBId: string): string {
  return [candidateAId, candidateBId].sort().join("__");
}

/**
 * ペアを抑制する（Keep Separate / Not Duplicate）。pairKey で upsert（冪等）。
 * 既に抑制済みなら kind / reason / 日時を更新する。
 */
export async function dismiss(
  input: DismissInput,
  db: DuplicateDismissalDb = prisma,
): Promise<{ pairKey: string }> {
  const pairKey = normalizePairKey(input.candidateAId, input.candidateBId);
  await db.duplicateDismissal.upsert({
    where: { pairKey },
    create: {
      pairKey,
      candidateAId: input.candidateAId,
      candidateBId: input.candidateBId,
      kind: input.kind,
      reason: input.reason ?? null,
    },
    update: { kind: input.kind, reason: input.reason ?? null },
  });
  return { pairKey };
}

/** 抑制済みの pairKey 集合を返す（サジェスト一覧の除外判定に使う）。 */
export async function listDismissedKeys(
  db: DuplicateDismissalDb = prisma,
): Promise<Set<string>> {
  const rows = await db.duplicateDismissal.findMany({ select: { pairKey: true } });
  return new Set(rows.map((r) => r.pairKey));
}

/** 重複抑制操作の集約 repository。 */
export const duplicateDismissalRepo = {
  dismiss,
  listDismissedKeys,
};
