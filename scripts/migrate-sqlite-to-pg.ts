// SQLite → Postgres データ移行（task-40, spec v2 §6.3 / §18.4 / §18.7）。
//
// 既存の「全件 JSON export→import」機構（scripts/export-all・import-all = task-25）をそのまま流用して
// データを移送する。Prisma の生成クライアントは provider 固有（SQLite 用クライアントで Postgres には
// 繋げない）ため、移行は本質的に 2 段階になる:
//
//   1) SQLite 側（既定の生成クライアント）で全件 export:
//        pnpm export-all exports/migrate.json
//   2) Postgres 用にクライアントを生成し、スキーマを用意してから本スクリプトで取り込む:
//        DATABASE_PROVIDER=postgres DATABASE_URL=postgresql://... \
//          pnpm exec prisma generate --schema prisma/schema.postgres.prisma
//        DATABASE_PROVIDER=postgres DATABASE_URL=postgresql://... \
//          pnpm exec prisma db push --schema prisma/schema.postgres.prisma
//        DATABASE_PROVIDER=postgres DATABASE_URL=postgresql://... \
//          node --env-file-if-exists=.env --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//               --disable-warning=ExperimentalWarning --experimental-transform-types \
//               scripts/migrate-sqlite-to-pg.ts exports/migrate.json
//
// 本スクリプト（= 上記 step 2 の取り込み）は Postgres 接続済みの生成クライアントで動く前提で:
//   - importAll でバンドルを Postgres へ復元（既存機構・原子的・auto-snapshot 付き／全モデル網羅）
//   - ensureSearchIndex で pg_trgm 全文検索索引を用意（lib/db/search.ts の Postgres 経路）
//   - exportAll で取り込み後の Postgres を読み直し、入力バンドルと**内容レベル**で一致するか検証する。
//     総件数だけでなく全テーブルの各レコード（主キー＋全フィールド）を diffBundles で突合し、
//     件数が合っても内容がズレる移行バグを検出する（往復一致）。
// を行う。全手順は docs/postgres-migration.md。

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

// このスクリプトは `node --experimental-transform-types` で直接実行する（docs の手順）。Node の型ストリップは
// **実行時に解決される相対 import に拡張子を要求する**（型のみ import は消去されるので不要）。export-all /
// import-all は実行時の相対 import を持たない（@prisma/client と型のみ）ため、明示拡張子付きで読めば解決できる。
// 一方 lib/db/search は実行時に `./client` 等を拡張子なしで辿るため node 単体では解決できない。そこで全文検索
// 索引の用意は search.ts を import せず、Postgres 経路の DDL（pg_trgm）だけを下の ensurePgSearchIndex に内製する
// （search.ts の公開 IF は不変。DDL は search.ts / docs §5 / migration と同じ＝既存の「索引の二重定義」方針に倣う）。
import { countRows, exportAll, EXPORTED_MODEL_NAMES, type ExportBundle } from "./export-all.ts";
import { importAll } from "./import-all.ts";

/** 内容一致検証で突合する全テーブル（バンドルのキー＝全モデル網羅）。 */
const BUNDLE_TABLES = [
  "rawSignals",
  "candidates",
  "evidence",
  "importBatches",
  "quarantineRows",
  "scoreSnapshots",
  "decisionLogs",
  "duplicateDismissals",
  "watchlists",
] as const;

// バンドルの全テーブルが EXPORTED_MODEL_NAMES（全モデル）と 1:1 で対応していることを
// import 時に静的保証する（モデル追加で BUNDLE_TABLES 更新を忘れたらここで型/件数が崩れる）。
if (BUNDLE_TABLES.length !== EXPORTED_MODEL_NAMES.length) {
  throw new Error(
    "BUNDLE_TABLES と EXPORTED_MODEL_NAMES の数が一致しません（全モデル網羅の前提が崩れています）。",
  );
}

// Postgres 全文検索（pg_trgm）の GIN 索引名。lib/db/search.ts の RAW_SIGNAL_TRGM_* と一致させること
// （search.ts を実行時 import できない事情から内製した複製。索引の二重定義は既存方針＝search.ts のコメント参照）。
const RAW_SIGNAL_TRGM_RAWTEXT_INDEX = "RawSignal_rawText_trgm_idx";
const RAW_SIGNAL_TRGM_ENTITY_INDEX = "RawSignal_observedEntity_trgm_idx";

/** pg_trgm 拡張＋GIN trigram 索引（冪等）。search.ts の PG_ENSURE_STATEMENTS と同一 DDL。 */
const PG_ENSURE_STATEMENTS: string[] = [
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  `CREATE INDEX IF NOT EXISTS "${RAW_SIGNAL_TRGM_RAWTEXT_INDEX}" ` +
    `ON "RawSignal" USING gin ("rawText" gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS "${RAW_SIGNAL_TRGM_ENTITY_INDEX}" ` +
    `ON "RawSignal" USING gin ("observedEntity" gin_trgm_ops)`,
];

/**
 * Postgres 全文検索（pg_trgm）の索引を冪等に用意する（lib/db/search.ts の ensureSearchIndex の Postgres
 * 経路と同一。索引は既存行も含めて張られ以後の更新へ自動追随する＝SQLite のような同期トリガ/backfill は不要）。
 * search.ts を実行時 import できないため DDL のみ複製する（公開 IF は search.ts 側が唯一の正）。
 */
async function ensurePgSearchIndex(db: PrismaClient): Promise<void> {
  for (const stmt of PG_ENSURE_STATEMENTS) {
    await db.$executeRawUnsafe(stmt);
  }
}

/** 1 件の差分（件数差・取りこぼし・余剰・内容不一致）。 */
export interface BundleDiff {
  table: string;
  kind: "count" | "missing" | "extra" | "field";
  detail: string;
}

/** キー順非依存の正規 JSON（行は全カラム scalar なので浅いキーソートで十分）。 */
function canonicalJson(row: unknown): string {
  // Date は JSON 化で ISO 文字列になり、入力（JSON 由来の文字列）と一致する。
  const obj = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
  return JSON.stringify(sorted);
}

/** テーブル行を id→正規 JSON の Map にする（内容差分検出の基盤）。 */
function indexById(rows: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const id = String((row as Record<string, unknown>).id);
    map.set(id, canonicalJson(row));
  }
  return map;
}

/**
 * 2 つのバンドルを**内容レベル**で突合する（総件数だけでなく、各レコードの主キーと
 * 全フィールドの一致を検証する＝指摘②対応）。全テーブルについて、件数・取りこぼし（missing）・
 * 余剰（extra）・内容不一致（field）を列挙して返す。差分ゼロなら往復一致。
 */
export function diffBundles(expected: ExportBundle, actual: ExportBundle): BundleDiff[] {
  const diffs: BundleDiff[] = [];
  for (const table of BUNDLE_TABLES) {
    const a = indexById((expected[table] as unknown[] | undefined) ?? []);
    const b = indexById((actual[table] as unknown[] | undefined) ?? []);
    if (a.size !== b.size) {
      diffs.push({ table, kind: "count", detail: `件数差: 期待 ${a.size} / 実際 ${b.size}` });
    }
    for (const [id, json] of a) {
      const other = b.get(id);
      if (other === undefined) {
        diffs.push({ table, kind: "missing", detail: `id=${id} が取り込み先に存在しない` });
      } else if (other !== json) {
        diffs.push({ table, kind: "field", detail: `id=${id} の内容が不一致` });
      }
    }
    for (const id of b.keys()) {
      if (!a.has(id)) {
        diffs.push({ table, kind: "extra", detail: `id=${id} が取り込み先に余分に存在する` });
      }
    }
  }
  return diffs;
}

/** 移行ガード: 取り込み先が Postgres であることを要求する（事故防止）。 */
function assertPostgresTarget(): void {
  const provider = (process.env.DATABASE_PROVIDER ?? "sqlite").trim().toLowerCase();
  if (provider !== "postgres" && provider !== "postgresql") {
    throw new Error(
      "DATABASE_PROVIDER=postgres を指定してください（このスクリプトは Postgres への取り込み専用）。" +
        " 手順は docs/postgres-migration.md を参照。",
    );
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(
      "DATABASE_URL が Postgres ではありません（postgresql://...）。SQLite を上書きしないよう中断します。",
    );
  }
}

/** 移行結果のサマリ（取り込み件数と往復一致の判定）。 */
export interface MigrateResult {
  restoredTotal: number;
  reexportedTotal: number;
  /** 内容レベルで往復一致したか（diffs が空＝OK）。 */
  roundTripMatch: boolean;
  /** 検出した差分（件数・取りこぼし・余剰・内容不一致）。空なら完全一致。 */
  diffs: BundleDiff[];
}

/**
 * バンドルを Postgres へ取り込み、全文検索索引を用意し、往復一致（総件数）を検証する。
 * @param bundle SQLite から export-all で書き出したバンドル。
 * @param db Postgres へ接続済みの Prisma クライアント。
 */
export async function migrateBundleToPostgres(
  bundle: ExportBundle,
  db: PrismaClient,
): Promise<MigrateResult> {
  const result = await importAll(bundle, db);
  const restoredTotal = Object.values(result.restored).reduce((sum, n) => sum + n, 0);

  // Postgres 全文検索（pg_trgm）の索引を用意する（lib/db/search.ts の Postgres 経路と同一 DDL）。
  await ensurePgSearchIndex(db);

  // 取り込み後の Postgres を読み直し、入力バンドルと**内容レベル**で一致するか検証する。
  // 総件数だけでなく、全テーブルの各レコード（主キー＋全フィールド）を突合する（指摘②）。
  const reexported = await exportAll(db);
  const reexportedTotal = countRows(reexported);
  const diffs = diffBundles(bundle, reexported);

  return {
    restoredTotal,
    reexportedTotal,
    roundTripMatch: diffs.length === 0,
    diffs,
  };
}

// ---------------------------------------------------------------------------
// CLI ランナー
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const inPath = process.argv[2];
  if (inPath === undefined) {
    console.error(
      "使い方: DATABASE_PROVIDER=postgres DATABASE_URL=postgresql://... node ... scripts/migrate-sqlite-to-pg.ts <export.json>",
    );
    process.exitCode = 1;
    return;
  }

  assertPostgresTarget();

  const bundle = JSON.parse(readFileSync(inPath, "utf8")) as ExportBundle;
  const db = new PrismaClient();
  try {
    const result = await migrateBundleToPostgres(bundle, db);
    console.log(
      `Postgres 取り込み完了: ${result.restoredTotal} 行を復元・全文検索索引を作成。` +
        ` 往復一致（内容レベル）: ${result.roundTripMatch ? "OK" : "NG"}（再 export ${result.reexportedTotal} 行）。`,
    );
    if (!result.roundTripMatch) {
      // 内容差分を先頭 20 件まで表示（件数差・取りこぼし・余剰・内容不一致）。
      console.error(`内容差分 ${result.diffs.length} 件を検出:`);
      for (const d of result.diffs.slice(0, 20)) {
        console.error(`  - [${d.table}] ${d.kind}: ${d.detail}`);
      }
      if (result.diffs.length > 20) console.error(`  …ほか ${result.diffs.length - 20} 件`);
      process.exitCode = 1;
    }
  } finally {
    await db.$disconnect();
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main().catch((error: unknown) => {
    console.error("migrate-sqlite-to-pg に失敗しました:", error);
    process.exitCode = 1;
  });
}
