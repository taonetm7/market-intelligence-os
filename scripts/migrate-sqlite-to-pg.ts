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
//   - importAll でバンドルを Postgres へ復元（既存機構・原子的・auto-snapshot 付き）
//   - ensureSearchIndex で pg_trgm 全文検索索引を用意（lib/db/search.ts の Postgres 経路）
//   - exportAll で取り込み後の Postgres を読み直し、入力バンドルと総件数が一致するか検証（往復一致）
// を行う。全手順は docs/postgres-migration.md。

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { ensureSearchIndex } from "../lib/db/search";
import { countRows, exportAll, type ExportBundle } from "./export-all";
import { importAll } from "./import-all";

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
  roundTripMatch: boolean;
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

  // Postgres 全文検索（pg_trgm）の索引を用意する（lib/db/search.ts の Postgres 経路）。
  await ensureSearchIndex(db);

  // 取り込み後の Postgres を読み直し、入力バンドルと総件数が一致するか確認する（往復一致）。
  const reexported = await exportAll(db);
  const reexportedTotal = countRows(reexported);

  return {
    restoredTotal,
    reexportedTotal,
    roundTripMatch: restoredTotal === reexportedTotal && reexportedTotal === countRows(bundle),
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
        ` 往復一致: ${result.roundTripMatch ? "OK" : "NG"}（再 export ${result.reexportedTotal} 行）。`,
    );
    if (!result.roundTripMatch) process.exitCode = 1;
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
