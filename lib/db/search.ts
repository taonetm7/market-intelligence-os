// RawSignal 全文検索（SQLite FTS5 / Postgres pg_trgm）— task-33 / task-40, spec v2 §9.3 / §18.1 / §6.3。
//
// RawSignal の rawText / observedEntity を全文検索する。DB 固有実装はこのファイルに閉じ込め、
// 公開インターフェース（searchRawSignalIds / search / toMatchQuery / ensureSearchIndex /
// reindexAll / RAW_SIGNAL_FTS_TABLE）は provider に依らず不変にする（rawSignalRepo 等の呼び出し側は
// searchRawSignalIds の戻り値＝id 配列にしか依存しない）。
//
// provider 分岐（task-40）:
//   - SQLite（既定）: FTS5 仮想テーブル＋同期トリガ＋trigram tokenizer（下記）。
//   - Postgres: pg_trgm 拡張＋GIN trigram 索引＋ILIKE による部分一致。FTS5 と同じ「含む」意味論
//     （CJK でも部分一致）を保つため tsvector/to_tsquery（語境界前提で CJK を分割できない）ではなく
//     pg_trgm を採る。索引は行更新に自動追随するため SQLite のような同期トリガは不要。
//   どちらを使うかは DATABASE_PROVIDER 環境変数で決める（未設定＝sqlite＝現状動作）。
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

/** FTS5 仮想テーブル名（SQLite 用・migration と一致させること）。 */
export const RAW_SIGNAL_FTS_TABLE = "RawSignalFts";

/** Postgres の pg_trgm GIN 索引名（rawText / observedEntity）。 */
export const RAW_SIGNAL_TRGM_RAWTEXT_INDEX = "RawSignal_rawText_trgm_idx";
export const RAW_SIGNAL_TRGM_ENTITY_INDEX = "RawSignal_observedEntity_trgm_idx";

/**
 * 現在の DB provider。DATABASE_PROVIDER 環境変数で切り替える（未設定＝sqlite＝現状動作）。
 * Prisma は datasource の provider に env() を使えない（P1012）ため、実際の Prisma クライアントは
 * schema.prisma（sqlite）/ schema.postgres.prisma（postgresql）のどちらで生成したかで決まる。
 * この関数はそれに合わせて「どの SQL 方言で検索するか」を決めるだけで、接続自体は生成済み
 * クライアントに従う（詳細は docs/postgres-migration.md）。
 */
function activeProvider(): "postgres" | "sqlite" {
  const p = (process.env.DATABASE_PROVIDER ?? "sqlite").trim().toLowerCase();
  return p === "postgres" || p === "postgresql" ? "postgres" : "sqlite";
}

/** Postgres 用: pg_trgm 拡張＋GIN trigram 索引（冪等）。索引は行更新へ自動追随（トリガ不要）。 */
const PG_ENSURE_STATEMENTS: string[] = [
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  `CREATE INDEX IF NOT EXISTS "${RAW_SIGNAL_TRGM_RAWTEXT_INDEX}" ` +
    `ON "RawSignal" USING gin ("rawText" gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS "${RAW_SIGNAL_TRGM_ENTITY_INDEX}" ` +
    `ON "RawSignal" USING gin ("observedEntity" gin_trgm_ops)`,
];

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
  if (activeProvider() === "postgres") {
    // pg_trgm 拡張＋GIN 索引を冪等に用意する。索引は既存行も含めて張られ、以後の更新へ自動追随する
    // （SQLite のような backfill / 同期トリガは不要）。
    for (const stmt of PG_ENSURE_STATEMENTS) {
      await db.$executeRawUnsafe(stmt);
    }
    return;
  }
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
  if (activeProvider() === "postgres") {
    // GIN trigram 索引は行更新に自動追随するため、索引を冪等に張り直すだけでよい
    // （SQLite のような全削除→全件再 INSERT は不要）。
    await ensureSearchIndex(db);
    return;
  }
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
 * Postgres ILIKE 用の部分一致パターン（`%q%`）へ変換する。LIKE のメタ文字（\ % _）はエスケープする
 * （Postgres LIKE/ILIKE の既定エスケープ文字はバックスラッシュ）。空・空白のみは null（検索スキップ）。
 */
function toLikePattern(q: string): string | null {
  const trimmed = q.trim();
  if (trimmed.length === 0) return null;
  const escaped = trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

/**
 * Postgres 版の id 検索。pg_trgm GIN 索引に支えられた ILIKE で rawText / observedEntity を
 * 部分一致検索する（CJK でも「含む」一致。FTS5 trigram と同じ意味論）。並びは addedAt 降順。
 * 索引が未作成でも ILIKE 自体は動作する（索引は性能のためのもの）。
 */
async function searchRawSignalIdsPg(q: string, db: SearchDb): Promise<string[]> {
  const pattern = toLikePattern(q);
  if (pattern === null) return [];
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "RawSignal" ` +
      `WHERE "rawText" ILIKE $1 OR COALESCE("observedEntity", '') ILIKE $1 ` +
      `ORDER BY "addedAt" DESC`,
    pattern,
  );
  return rows.map((r) => r.id);
}

/**
 * q にマッチする RawSignal.id を関連度（rank）順で返す。FTS テーブルが未作成（migration 非適用の
 * DB）なら一度だけ ensureSearchIndex で張ってから再試行する。空クエリは空配列。
 */
export async function searchRawSignalIds(q: string, db: SearchDb = prisma): Promise<string[]> {
  if (activeProvider() === "postgres") {
    return searchRawSignalIdsPg(q, db);
  }
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
