// RawSignal 全文検索（SQLite FTS5）— task-33, spec v2 §9.3 / §18.1。
//
// RawSignal の rawText / observedEntity を SQLite の FTS5 仮想テーブルで全文検索する。
// SQLite 固有（FTS5 の DDL・MATCH 構文）はこのファイルに閉じ込め、task-40 の Postgres 移行時は
// ここだけを差し替えられるようにする（rawSignalRepo は searchRawSignalIds の戻り値＝id 配列にしか
// 依存しない）。
//
// tokenizer 選定（trigram）:
//   日本語は語境界（空白）が無いため、unicode61 は CJK の連続を 1 トークンとして扱い「部分一致」が
//   成立しない（例: 「全文検索」で「日本語の全文検索テスト」を引けない）。trigram は文字 3-gram を
//   索引するため CJK でも部分一致でき、英数の substring 検索（旧 LIKE contains 相当）も得られる。
//   代償として 3 文字未満のクエリは原理的にマッチしない（trigram の制約・§9.3 の検索は 3 文字以上想定）。
//
// 索引の所在（二重定義の理由）:
//   実 DB では prisma/migrations の raw SQL migration が仮想テーブル＋トリガ＋既存行 backfill を作る
//   （§18.1 / acceptance: migration で作成）。一方テスト等は `prisma db push`（migration 非適用）で
//   スキーマを用意するため FTS テーブルが存在しない。そこで同等の DDL を IF NOT EXISTS で冪等に張り直す
//   ensureSearchIndex をここにも持ち、migration 未適用の DB でも遅延生成できるようにする（両者は同じ構造）。

import { type PrismaClient, type RawSignal } from "@prisma/client";

import { prisma } from "./client";

/** 検索が受け取る Prisma クライアント（raw SQL を流すためフル機能の PrismaClient）。 */
export type SearchDb = PrismaClient;

/** FTS5 仮想テーブル名（migration と一致させること）。 */
export const RAW_SIGNAL_FTS_TABLE = "RawSignalFts";

/**
 * 仮想テーブル＋同期トリガの DDL（冪等版）。migration の DDL と同じ構造を IF NOT EXISTS で表現する。
 * - signalId は UNINDEXED（検索対象でなく RawSignal.id への参照のため）。
 * - rawText / observedEntity を索引対象にする（§9.3）。observedEntity は NULL を空文字に畳む。
 * - トリガで INSERT/UPDATE/DELETE を FTS へ反映する（UPDATE は delete→insert で表現）。
 */
const ENSURE_STATEMENTS: string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS "${RAW_SIGNAL_FTS_TABLE}" USING fts5(` +
    `signalId UNINDEXED, rawText, observedEntity, tokenize = 'trigram')`,
  `CREATE TRIGGER IF NOT EXISTS "${RAW_SIGNAL_FTS_TABLE}_ai" AFTER INSERT ON "RawSignal" BEGIN ` +
    `INSERT INTO "${RAW_SIGNAL_FTS_TABLE}"(signalId, rawText, observedEntity) ` +
    `VALUES (new.id, new.rawText, COALESCE(new.observedEntity, '')); END`,
  `CREATE TRIGGER IF NOT EXISTS "${RAW_SIGNAL_FTS_TABLE}_ad" AFTER DELETE ON "RawSignal" BEGIN ` +
    `DELETE FROM "${RAW_SIGNAL_FTS_TABLE}" WHERE signalId = old.id; END`,
  `CREATE TRIGGER IF NOT EXISTS "${RAW_SIGNAL_FTS_TABLE}_au" AFTER UPDATE ON "RawSignal" BEGIN ` +
    `DELETE FROM "${RAW_SIGNAL_FTS_TABLE}" WHERE signalId = old.id; ` +
    `INSERT INTO "${RAW_SIGNAL_FTS_TABLE}"(signalId, rawText, observedEntity) ` +
    `VALUES (new.id, new.rawText, COALESCE(new.observedEntity, '')); END`,
];

/** トリガ作成より前に存在した行を索引へ補充する（既に索引済みの行はスキップ）。 */
const BACKFILL_MISSING = `INSERT INTO "${RAW_SIGNAL_FTS_TABLE}"(signalId, rawText, observedEntity) ` +
  `SELECT id, rawText, COALESCE(observedEntity, '') FROM "RawSignal" r ` +
  `WHERE NOT EXISTS (SELECT 1 FROM "${RAW_SIGNAL_FTS_TABLE}" f WHERE f.signalId = r.id)`;

/**
 * FTS 索引（仮想テーブル＋トリガ）を冪等に用意し、未索引の既存行を補充する。
 * migration が適用済みの実 DB では no-op に近い（IF NOT EXISTS / WHERE NOT EXISTS）。
 * `prisma db push` で用意した DB（テスト等）では、ここで初めて索引が張られる。
 */
export async function ensureSearchIndex(db: SearchDb = prisma): Promise<void> {
  for (const stmt of ENSURE_STATEMENTS) {
    await db.$executeRawUnsafe(stmt);
  }
  await db.$executeRawUnsafe(BACKFILL_MISSING);
}

/**
 * 索引を作り直す（全削除→全件再 INSERT）。migration の backfill と同じ「再インデックス手順」を
 * 実行時にも提供する（既存行の取りこぼし復旧・運用スクリプト用）。テーブルが無ければ先に用意する。
 */
export async function reindexAll(db: SearchDb = prisma): Promise<void> {
  await ensureSearchIndex(db);
  await db.$executeRawUnsafe(`DELETE FROM "${RAW_SIGNAL_FTS_TABLE}"`);
  await db.$executeRawUnsafe(
    `INSERT INTO "${RAW_SIGNAL_FTS_TABLE}"(signalId, rawText, observedEntity) ` +
      `SELECT id, rawText, COALESCE(observedEntity, '') FROM "RawSignal"`,
  );
}

/**
 * ユーザー入力を FTS5 MATCH 式へ変換する。クエリ全体を 1 つのフレーズ（"..."）として扱い、
 * trigram による部分一致（旧 LIKE contains 相当）にする。内部の二重引用符は "" にエスケープする。
 * 空文字・空白のみは null（呼び出し側は検索をスキップする）。
 */
export function toMatchQuery(q: string): string | null {
  const trimmed = q.trim();
  if (trimmed.length === 0) return null;
  return `"${trimmed.replace(/"/g, '""')}"`;
}

/**
 * q にマッチする RawSignal.id を関連度（rank）順で返す。FTS テーブルが未作成（migration 非適用の
 * DB）なら一度だけ ensureSearchIndex で張ってから再試行する。空クエリは空配列。
 */
export async function searchRawSignalIds(q: string, db: SearchDb = prisma): Promise<string[]> {
  const match = toMatchQuery(q);
  if (match === null) return [];

  const run = () =>
    db.$queryRawUnsafe<{ signalId: string }[]>(
      `SELECT signalId FROM "${RAW_SIGNAL_FTS_TABLE}" ` +
        `WHERE "${RAW_SIGNAL_FTS_TABLE}" MATCH ? ORDER BY rank`,
      match,
    );

  let rows: { signalId: string }[];
  try {
    rows = await run();
  } catch (error) {
    // migration 未適用で仮想テーブルが無い場合のみ、遅延生成して再試行する。
    if (error instanceof Error && /no such table/i.test(error.message)) {
      await ensureSearchIndex(db);
      rows = await run();
    } else {
      throw error;
    }
  }
  return rows.map((r) => r.signalId);
}

/**
 * q にマッチする RawSignal 行を返す（id 検索 → 本体取得）。一覧 UI からの直接利用や将来の
 * Candidate 側検索の足場に使える薄いヘルパ。並びは addedAt 降順（一覧の既定と一致）。
 */
export async function search(q: string, db: SearchDb = prisma): Promise<RawSignal[]> {
  const ids = await searchRawSignalIds(q, db);
  if (ids.length === 0) return [];
  return db.rawSignal.findMany({
    where: { id: { in: ids } },
    orderBy: { addedAt: "desc" },
  });
}
