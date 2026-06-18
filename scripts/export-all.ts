// 全件 JSON export — task-25, spec v2 §18.4。
//
// コア5テーブル＋運用テーブル（ImportBatch / QuarantineRow）＋後続追加モデル
// （DuplicateDismissal=task-35 / Watchlist=task-36）を 1 つの JSON バンドルへ書き出す。
// `pnpm export-all [出力パス]` で実行し、出力先は既定で
// `exports/export-<ISO8601>.json`（§18.4: git 管理する export ディレクトリ）。
//
// 網羅性の担保（task-40 Phase 2）: バンドルが Prisma の全モデルを確実に含むよう、
// EXPORTED_MODEL_NAMES に全モデル名を明示列挙し、DMMF（実スキーマ）との突合テスト
// （tests/db/migration-coverage.test.ts）で「モデル追加時の export 漏れ」を検出する。
// SQLite→Postgres 移行（scripts/migrate-sqlite-to-pg.ts）はこの全件バンドルに依存する。
//
// 設計方針:
// - 依存を増やさない。@prisma/client だけを使い、独自の loader フックは要らない
//   （lib への拡張子なし相対 import / JSON import をしないため、Node の TS 実行で素直に動く）。
// - exportAll は純粋な読み出し（DB を変更しない）。バンドルを返すだけにして、
//   ファイル書き込みは CLI 側に分離する（テストから exportAll を直接呼べる）。
// - import-all と往復してデータが一致するよう、id・タイムスタンプを含む全カラムを出す。
//
// Out of scope: Deep Research 用の 1 件 export（Slice 3 task-32）/ 増分 export。

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

/**
 * export バンドルの形（テーブルごとの全行）。import-all はこの形を受け取って復元する。
 * `version` はフォーマットの版（将来スキーマが増えたときの互換判定用）。
 */
export interface ExportBundle {
  version: 1;
  exportedAt: string;
  rawSignals: unknown[];
  candidates: unknown[];
  evidence: unknown[];
  importBatches: unknown[];
  quarantineRows: unknown[];
  scoreSnapshots: unknown[];
  decisionLogs: unknown[];
  duplicateDismissals: unknown[];
  watchlists: unknown[];
}

/** export フォーマットの版（import-all の互換チェックと揃える）。 */
export const EXPORT_FORMAT_VERSION = 1 as const;

/**
 * export / import が網羅する Prisma モデル名（全件移行の単一の正＝source of truth）。
 * 実スキーマ（DMMF）との突合テストでここに無いモデルを検出し、移行漏れを防ぐ
 * （tests/db/migration-coverage.test.ts）。モデルを追加したら必ずここと exportAll に反映する。
 */
export const EXPORTED_MODEL_NAMES = [
  "RawSignal",
  "Candidate",
  "Evidence",
  "ImportBatch",
  "QuarantineRow",
  "ScoreSnapshot",
  "DecisionLog",
  "DuplicateDismissal",
  "Watchlist",
] as const;

/**
 * 全テーブルを読み出してバンドルを返す（DB は変更しない）。
 * 行順は id 昇順で決定的にする（往復・差分比較を安定させる）。
 * @param db 読み出し元 Prisma クライアント。省略時は DATABASE_URL のシングルトン。
 * @param now exportedAt に使う時刻（テストの決定論性のため注入可能）。
 */
export async function exportAll(
  db: PrismaClient = new PrismaClient(),
  now: Date = new Date(),
): Promise<ExportBundle> {
  const [
    rawSignals,
    candidates,
    evidence,
    importBatches,
    quarantineRows,
    scoreSnapshots,
    decisionLogs,
    duplicateDismissals,
    watchlists,
  ] = await Promise.all([
    db.rawSignal.findMany({ orderBy: { id: "asc" } }),
    db.candidate.findMany({ orderBy: { id: "asc" } }),
    db.evidence.findMany({ orderBy: { id: "asc" } }),
    db.importBatch.findMany({ orderBy: { id: "asc" } }),
    db.quarantineRow.findMany({ orderBy: { id: "asc" } }),
    db.scoreSnapshot.findMany({ orderBy: { id: "asc" } }),
    db.decisionLog.findMany({ orderBy: { id: "asc" } }),
    db.duplicateDismissal.findMany({ orderBy: { id: "asc" } }),
    db.watchlist.findMany({ orderBy: { id: "asc" } }),
  ]);

  return {
    version: EXPORT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    rawSignals,
    candidates,
    evidence,
    importBatches,
    quarantineRows,
    scoreSnapshots,
    decisionLogs,
    duplicateDismissals,
    watchlists,
  };
}

/** バンドルの総行数（CLI のサマリ表示・テストの件数突合に使う）。 */
export function countRows(bundle: ExportBundle): number {
  return (
    bundle.rawSignals.length +
    bundle.candidates.length +
    bundle.evidence.length +
    bundle.importBatches.length +
    bundle.quarantineRows.length +
    bundle.scoreSnapshots.length +
    bundle.decisionLogs.length +
    bundle.duplicateDismissals.length +
    bundle.watchlists.length
  );
}

// ---------------------------------------------------------------------------
// CLI ランナー（pnpm export-all [出力パス]）
// ---------------------------------------------------------------------------

/** ISO8601 をファイル名に使える形へ（コロン/ドットをハイフンに）。 */
function timestampForFilename(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const now = new Date();
  const argPath = process.argv[2];
  const outPath = argPath ?? join("exports", `export-${timestampForFilename(now)}.json`);

  const db = new PrismaClient();
  try {
    const bundle = await exportAll(db, now);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    console.log(`export 完了: ${countRows(bundle)} 行 → ${outPath}`);
  } finally {
    await db.$disconnect();
  }
}

// `node scripts/export-all.ts` で直接起動されたときだけ CLI を実行する。
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  // fileURLToPath を一度通して、シンボリックリンク等でも一致を安定させる。
  import.meta.url === pathToFileURL(fileURLToPath(import.meta.url)).href;

if (invokedDirectly) {
  await main().catch((error: unknown) => {
    console.error("export-all に失敗しました:", error);
    process.exitCode = 1;
  });
}
