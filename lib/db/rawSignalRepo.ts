// RawSignal repository — task-08, spec v2 §7.2 / §9.3。
//
// RawSignal の CRUD と一覧フィルタをこの層に集約する。UI / API route（task-11）は
// Prisma を直接触らず、必ずこの repository を経由する。
//
// 設計方針:
// - enum（sourceType / status / origin）は task-02 の Zod スキーマで検証する
//   （文字列直書き禁止）。入力は repository の入口で必ず parse する。
// - 配列/オブジェクト（signalTags / extra）は task-02 の JSON ヘルパで
//   `*Json` カラムと往復する（SQLite に配列型が無いため）。
// - displayId（RS-YYYYMMDD-NNN）は task-07 の採番関数を、挿入と同一トランザクション
//   内で呼ぶ（連番の競合を局所化する）。
// - status から "linked" は廃止。「未紐付け（inbox）」は Evidence 0 件で派生判定する
//   （unlinkedOnly フィルタ）。
//
// テスト容易性: 各関数は最後の引数で Prisma クライアントを差し替えられる（既定は
//   シングルトン）。テストは専用の SQLite ファイルへ向けた Client を注入する。
//
// Out of scope: API route（task-11）/ Evidence link 自体の作成（task-10/12）。

import { Prisma, type PrismaClient, type RawSignal } from "@prisma/client";
import { z } from "zod";

import { originSchema, sourceTypeSchema, statusSchema } from "../validation/enums";
import {
  parseJsonField,
  rawSignalInputSchema,
  serializeJsonField,
  type RawSignalInput,
} from "../validation/schemas";
import { prisma } from "./client";
import { nextRawSignalDisplayId } from "./displayId";
import { searchRawSignalIds } from "./search";

/**
 * repository が受け取る Prisma クライアント。
 * トランザクションを張る create があるため、TransactionClient ではなく
 * フル機能の PrismaClient を要求する。
 */
export type RawSignalDb = PrismaClient;

/**
 * 読み出し時のドメイン表現。`*Json` カラムを復元した `signalTags` / `extra` を
 * 持つ（呼び出し側は JSON 文字列を意識しなくてよい）。
 */
export type RawSignalRecord = RawSignal & {
  signalTags: string[];
  extra: Record<string, unknown>;
};

/** 一覧の各行。紐付け候補数（Evidence 件数）を付与する（§9.3 のカラム）。 */
export type RawSignalListItem = RawSignalRecord & {
  evidenceCount: number;
};

/** list のフィルタ条件（すべて任意）。 */
export interface RawSignalListFilter {
  sourceType?: string;
  status?: string;
  /** Evidence が 0 件（＝どの Candidate にも紐付いていない inbox）だけを返す。 */
  unlinkedOnly?: boolean;
  /** 全文検索（rawText / observedEntity）。task-33 で FTS5（trigram）へアップグレード。 */
  q?: string;
}

/**
 * 更新パッチ。入力スキーマの部分集合（省略フィールドは変更しない）。
 *
 * 注意: `rawSignalInputSchema.partial()` だけでは不十分。Zod は `.partial()` を
 * かけても default を持つフィールド（signalTags / extra / origin / status）の
 * default を、キー省略時に materialize してしまう（例: `parse({ note: "x" })`
 * → `signalTags: []`, `origin: "manual"` が混入）。これをそのまま update に流すと
 * 「省略したフィールドが default で上書き」される（Codex 指摘1）。
 * そこで default を持つ 4 フィールドだけ default 無しの optional に差し替え、
 * 「省略＝undefined＝変更しない」を構造的に保証する。
 */
export const rawSignalUpdateSchema = rawSignalInputSchema.partial().extend({
  signalTags: z.array(z.string()).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  origin: originSchema.optional(),
  status: statusSchema.optional(),
});
export type RawSignalUpdate = Partial<RawSignalInput>;

/** Prisma 行をドメイン表現へ復元する（`*Json` → 配列/オブジェクト）。 */
function decode(row: RawSignal): RawSignalRecord {
  return {
    ...row,
    signalTags: parseJsonField<string[]>(row.signalTagsJson, []),
    extra: parseJsonField<Record<string, unknown>>(row.extraJson, {}),
  };
}

/**
 * RawSignal を 1 件作成する。
 * 入力を Zod 検証し、displayId 採番と挿入を同一トランザクションで束ねる。
 */
export async function create(
  input: RawSignalInput,
  db: RawSignalDb = prisma,
): Promise<RawSignalRecord> {
  const data = rawSignalInputSchema.parse(input);
  const row = await db.$transaction(async (tx) => {
    const displayId = await nextRawSignalDisplayId(tx);
    return tx.rawSignal.create({
      data: {
        displayId,
        sourceType: data.sourceType,
        sourceName: data.sourceName,
        sourceUrl: data.sourceUrl,
        country: data.country,
        language: data.language,
        rawText: data.rawText,
        observedEntity: data.observedEntity,
        observedPrice: data.observedPrice,
        observedRank: data.observedRank,
        observedRating: data.observedRating,
        observedReviews: data.observedReviews,
        observedUpdate: data.observedUpdate,
        signalTagsJson: serializeJsonField(data.signalTags),
        extraJson: serializeJsonField(data.extra),
        note: data.note,
        origin: data.origin,
        status: data.status,
      },
    });
  });
  return decode(row);
}

/** id で 1 件取得する。存在しなければ null。 */
export async function getById(
  id: string,
  db: RawSignalDb = prisma,
): Promise<RawSignalRecord | null> {
  const row = await db.rawSignal.findUnique({ where: { id } });
  return row ? decode(row) : null;
}

/**
 * 部分更新する。省略フィールドは変更しない（displayId / id は不変）。
 * signalTags / extra が与えられた場合のみ `*Json` を再直列化する。
 */
export async function update(
  id: string,
  patch: RawSignalUpdate,
  db: RawSignalDb = prisma,
): Promise<RawSignalRecord> {
  const data = rawSignalUpdateSchema.parse(patch);
  const updateData: Prisma.RawSignalUpdateInput = {};
  if (data.sourceType !== undefined) updateData.sourceType = data.sourceType;
  if (data.sourceName !== undefined) updateData.sourceName = data.sourceName;
  if (data.sourceUrl !== undefined) updateData.sourceUrl = data.sourceUrl;
  if (data.country !== undefined) updateData.country = data.country;
  if (data.language !== undefined) updateData.language = data.language;
  if (data.rawText !== undefined) updateData.rawText = data.rawText;
  if (data.observedEntity !== undefined) updateData.observedEntity = data.observedEntity;
  if (data.observedPrice !== undefined) updateData.observedPrice = data.observedPrice;
  if (data.observedRank !== undefined) updateData.observedRank = data.observedRank;
  if (data.observedRating !== undefined) updateData.observedRating = data.observedRating;
  if (data.observedReviews !== undefined) updateData.observedReviews = data.observedReviews;
  if (data.observedUpdate !== undefined) updateData.observedUpdate = data.observedUpdate;
  if (data.signalTags !== undefined) updateData.signalTagsJson = serializeJsonField(data.signalTags);
  if (data.extra !== undefined) updateData.extraJson = serializeJsonField(data.extra);
  if (data.note !== undefined) updateData.note = data.note;
  if (data.origin !== undefined) updateData.origin = data.origin;
  if (data.status !== undefined) updateData.status = data.status;

  const row = await db.rawSignal.update({ where: { id }, data: updateData });
  return decode(row);
}

/** id で 1 件削除する。 */
export async function deleteById(id: string, db: RawSignalDb = prisma): Promise<void> {
  await db.rawSignal.delete({ where: { id } });
}

/**
 * 一覧を返す。sourceType / status は Zod 検証してから where に積む。
 * q は contains（LIKE）で rawText / observedEntity / sourceName / note を横断検索。
 * unlinkedOnly は inbox かつ Evidence 0 件のみ（`status: "inbox"` ＋ `evidences: { none: {} }`）。
 * 各行に紐付け候補数（evidenceCount）を付与する。
 */
export async function list(
  filter: RawSignalListFilter = {},
  db: RawSignalDb = prisma,
): Promise<RawSignalListItem[]> {
  const where: Prisma.RawSignalWhereInput = {};
  if (filter.sourceType !== undefined) {
    where.sourceType = sourceTypeSchema.parse(filter.sourceType);
  }
  if (filter.status !== undefined) {
    where.status = statusSchema.parse(filter.status);
  }
  if (filter.q !== undefined && filter.q.trim() !== "") {
    // 全文検索は FTS5（trigram）経由（task-33）。rawText / observedEntity を索引し、マッチした
    // RawSignal.id 集合で絞り込む（旧 contains/LIKE からの差し替え）。SQLite 固有は search.ts に
    // 閉じ込め、ここは id 配列にしか依存しない（task-40 Postgres 移行時の切替点を局所化）。
    // マッチ 0 件は `in: []` となり「該当なし」を表す。
    const ids = await searchRawSignalIds(filter.q, db);
    where.id = { in: ids };
  }
  if (filter.unlinkedOnly) {
    // task doc 定義: unlinkedOnly は「Evidence が0件の inbox」を返す（Codex 指摘2）。
    // Evidence 0件でも archived / ignored は未処理の inbox ではないため除外する。
    // status を明示的に inbox へ固定する（status フィルタと併用時も inbox が優先）。
    where.status = "inbox";
    where.evidences = { none: {} };
  }

  const rows = await db.rawSignal.findMany({
    where,
    orderBy: { addedAt: "desc" },
    include: { _count: { select: { evidences: true } } },
  });
  return rows.map(({ _count, ...row }) => ({
    ...decode(row),
    evidenceCount: _count.evidences,
  }));
}

/** RawSignal 操作の集約 repository（delete を含むため named export と併設）。 */
export const rawSignalRepo = {
  create,
  getById,
  update,
  delete: deleteById,
  list,
};
