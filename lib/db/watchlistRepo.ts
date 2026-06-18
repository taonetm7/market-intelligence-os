// Watchlist repository — task-36, spec v2 §9.8 / フィールドは §7.7。
//
// 定点観測対象（競合アプリ / キーワード / ランキング / テンプレ販売 / 外注カテゴリ / 法改正ページ /
// プラグイン）の前回値・今回値・差分を管理する。v1 は手動入力（自動取得・スクレイピングは §18.3 で
// out of scope）。UI / API route（task-37 / 本タスクの route）は Prisma を直接触らず、この repository を
// 経由する。
//
// 設計方針:
// - enum（entityType / deltaFlag）は task-02 の Zod スキーマで検証する（文字列直書き禁止）。
//   入力は repository の入口で必ず parse する。
// - updateValue: 手動入力の新値で current→last へシフト（lastValue←currentValue, currentValue←new）し、
//   deltaFlag を数値比較で算出（up/down/unchanged、比較不能/初回は unknown）。lastCheckedAt を更新。
// - 差分判定（computeDeltaFlag）は I/O を持たない純関数として切り出し、node テストで直接駆動する。
//
// テスト容易性: 各関数は最後の引数で Prisma クライアントを差し替えられる（既定はシングルトン）。
//
// Out of scope: UI（task-37）/ 自動取得（§18.3）。

import { type Prisma, type PrismaClient, type Watchlist } from "@prisma/client";
import { z } from "zod";

import { deltaFlagSchema, watchlistEntityTypeSchema, type DeltaFlag } from "../validation/enums";
import { watchlistInputSchema, type WatchlistInput } from "../validation/schemas";
import { prisma } from "./client";

/**
 * repository が受け取る Prisma クライアント。
 * updateValue が読み取り→更新をトランザクションで束ねるためフル機能の PrismaClient を要求する。
 */
export type WatchlistDb = PrismaClient;

/**
 * 更新パッチ。入力スキーマの部分集合（省略フィールドは変更しない）。
 * deltaFlag は default("unknown") を持つため、`.partial()` だけでは省略時に default が materialize
 * され「省略フィールドが上書き」される（rawSignalRepo と同じ事情）。default 無しの optional へ
 * 差し替えて「省略＝undefined＝変更しない」を構造的に保証する。
 */
export const watchlistUpdateSchema = watchlistInputSchema.partial().extend({
  deltaFlag: deltaFlagSchema.optional(),
});
export type WatchlistUpdate = Partial<WatchlistInput>;

/** list のフィルタ条件（すべて任意）。 */
export interface WatchlistListFilter {
  entityType?: string;
  linkedCandidateId?: string;
}

/** 値が「比較対象として有効」か（null / undefined / 空白のみは無効）。 */
function presentValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * 前回値 → 今回値の差分方向を算出する（純関数）。
 * 両者が有限数値として解釈できるときだけ up / down / unchanged を返し、
 * 一方でも欠落 / 数値化できない（比較不能・初回）は unknown を返す（§9.8）。
 */
export function computeDeltaFlag(
  prev: string | null | undefined,
  next: string | null | undefined,
): DeltaFlag {
  if (!presentValue(prev) || !presentValue(next)) return "unknown";
  const pn = Number(prev);
  const nn = Number(next);
  if (!Number.isFinite(pn) || !Number.isFinite(nn)) return "unknown";
  if (nn > pn) return "up";
  if (nn < pn) return "down";
  return "unchanged";
}

/** Watchlist を 1 件作成する。入力を Zod 検証してから挿入する。 */
export async function create(input: WatchlistInput, db: WatchlistDb = prisma): Promise<Watchlist> {
  const data = watchlistInputSchema.parse(input);
  return db.watchlist.create({
    data: {
      entityType: data.entityType,
      entityName: data.entityName,
      locale: data.locale,
      metricName: data.metricName,
      lastValue: data.lastValue,
      currentValue: data.currentValue,
      deltaFlag: data.deltaFlag,
      lastCheckedAt: data.lastCheckedAt,
      linkedCandidateId: data.linkedCandidateId,
      note: data.note,
    },
  });
}

/** id で 1 件取得する。存在しなければ null。 */
export async function getById(id: string, db: WatchlistDb = prisma): Promise<Watchlist | null> {
  return db.watchlist.findUnique({ where: { id } });
}

/**
 * 部分更新する。省略フィールドは変更しない（id は不変）。
 * 値シフト＋差分算出は updateValue を使う（ここは任意フィールドの直接編集）。
 */
export async function update(
  id: string,
  patch: WatchlistUpdate,
  db: WatchlistDb = prisma,
): Promise<Watchlist> {
  const data = watchlistUpdateSchema.parse(patch);
  const updateData: Prisma.WatchlistUpdateInput = {};
  if (data.entityType !== undefined) updateData.entityType = data.entityType;
  if (data.entityName !== undefined) updateData.entityName = data.entityName;
  if (data.locale !== undefined) updateData.locale = data.locale;
  if (data.metricName !== undefined) updateData.metricName = data.metricName;
  if (data.lastValue !== undefined) updateData.lastValue = data.lastValue;
  if (data.currentValue !== undefined) updateData.currentValue = data.currentValue;
  if (data.deltaFlag !== undefined) updateData.deltaFlag = data.deltaFlag;
  if (data.lastCheckedAt !== undefined) updateData.lastCheckedAt = data.lastCheckedAt;
  if (data.note !== undefined) updateData.note = data.note;
  if (data.linkedCandidateId !== undefined) {
    // 三値: 非空 id=connect / null（または検証層を通り抜けた空文字）=disconnect。
    // undefined は上の guard で除外済み（= 触らない）。UI の「紐付けなし」選択は null で届く（task-37）。
    updateData.linkedCandidate = data.linkedCandidateId
      ? { connect: { id: data.linkedCandidateId } }
      : { disconnect: true };
  }
  return db.watchlist.update({ where: { id }, data: updateData });
}

/** updateValue の新値スキーマ（非空の文字列）。 */
const newValueSchema = z.string().min(1);

/**
 * 手動入力の新値を反映する（§9.8 の中核）。
 * current → last へシフト（lastValue←現 currentValue, currentValue←new）し、deltaFlag を数値比較で
 * 算出、lastCheckedAt を更新する。存在しない id は P2025（route が 404 に翻訳）。
 */
export async function updateValue(
  id: string,
  newValue: string,
  db: WatchlistDb = prisma,
): Promise<Watchlist> {
  const value = newValueSchema.parse(newValue);
  return db.$transaction(async (tx) => {
    const existing = await tx.watchlist.findUnique({ where: { id } });
    if (existing === null) {
      // 不在は update 経由で P2025 を投げさせ、route の 404 経路に乗せる。
      return tx.watchlist.update({ where: { id }, data: {} });
    }
    const lastValue = existing.currentValue;
    return tx.watchlist.update({
      where: { id },
      data: {
        lastValue,
        currentValue: value,
        deltaFlag: computeDeltaFlag(lastValue, value),
        lastCheckedAt: new Date(),
      },
    });
  });
}

/** id で 1 件削除する。 */
export async function deleteById(id: string, db: WatchlistDb = prisma): Promise<void> {
  await db.watchlist.delete({ where: { id } });
}

/**
 * 一覧を返す。entityType / linkedCandidateId は where に積む（entityType は Zod 検証）。
 * 並びは更新の新しい順（updatedAt 降順）。
 */
export async function list(
  filter: WatchlistListFilter = {},
  db: WatchlistDb = prisma,
): Promise<Watchlist[]> {
  const where: Prisma.WatchlistWhereInput = {};
  if (filter.entityType !== undefined) {
    where.entityType = watchlistEntityTypeSchema.parse(filter.entityType);
  }
  if (filter.linkedCandidateId !== undefined) {
    where.linkedCandidateId = filter.linkedCandidateId;
  }
  return db.watchlist.findMany({ where, orderBy: { updatedAt: "desc" } });
}

/** Watchlist 操作の集約 repository（delete を含むため named export と併設）。 */
export const watchlistRepo = {
  create,
  getById,
  update,
  updateValue,
  delete: deleteById,
  list,
};
