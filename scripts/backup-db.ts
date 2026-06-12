// DB スナップショット（ファイルコピー）— task-25, spec v2 §18.4。
//
// SQLite の DB ファイルをそのままコピーしてスナップショットを取る（§18.4: DB ファイルコピー）。
// `pnpm backup-db [出力パス]` で実行する。出力先は既定で `backups/dev-<ISO8601>.db`
// （*.db は .gitignore 対象＝バックアップはコミットしない）。
//
// 設計方針:
// - 依存・DB 接続なし。ファイルコピーだけ（Prisma も読まない）。
// - DATABASE_URL（`file:...`）から実ファイルの場所を解決する。相対パスは Prisma と同じく
//   schema.prisma のあるディレクトリ（prisma/）基準で解決する（このプロジェクトの dev.db は
//   prisma/dev.db）。
// - 純粋な経路解決（resolveDbPath）とコピー本体（backupDb）を分け、テストから経路解決を
//   検証できるようにする。
//
// Out of scope: 復元（import-all / 手動で戻す）/ 週次スケジューラ。

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** プロジェクトルート（scripts/ の 1 つ上）。 */
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Prisma が相対 file: URL を解決する基準（schema.prisma のあるディレクトリ）。 */
const PRISMA_DIR = join(PROJECT_ROOT, "prisma");

/** バックアップが見つからない/不正なときの明示エラー。 */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

/**
 * DATABASE_URL（`file:...`）から実 DB ファイルの絶対パスを解決する純粋関数。
 * 相対パスは `baseDir`（既定 prisma/）基準で解決する（Prisma の解決規則に合わせる）。
 * `file:` 以外（将来 Postgres 等）はコピー対象外として明示エラーにする。
 */
export function resolveDbPath(databaseUrl: string | undefined, baseDir: string = PRISMA_DIR): string {
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new BackupError("DATABASE_URL が未設定です");
  }
  if (!databaseUrl.startsWith("file:")) {
    throw new BackupError(`SQLite（file:）以外はバックアップ対象外です: ${databaseUrl}`);
  }
  const raw = databaseUrl.slice("file:".length);
  return isAbsolute(raw) ? raw : join(baseDir, raw);
}

/** ISO8601 をファイル名に使える形へ（コロン/ドットをハイフンに）。 */
function timestampForFilename(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** backupDb のオプション（すべて任意・テストから注入できる）。 */
export interface BackupOptions {
  /** 既定は process.env.DATABASE_URL。 */
  databaseUrl?: string;
  /** 出力先パス。既定は backups/dev-<ts>.db。 */
  destPath?: string;
  /** ファイル名のタイムスタンプ基準（テストの決定論性のため）。 */
  now?: Date;
  /** 相対 file: URL の解決基準（既定 prisma/）。 */
  baseDir?: string;
}

/** バックアップ結果（コピー元と出力先の絶対/相対パス）。 */
export interface BackupResult {
  src: string;
  dest: string;
}

/**
 * DB ファイルをコピーしてスナップショットを作る。
 * @returns コピー元（src）と出力先（dest）。
 */
export function backupDb(options: BackupOptions = {}): BackupResult {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const now = options.now ?? new Date();
  const src = resolveDbPath(databaseUrl, options.baseDir);
  const dest = options.destPath ?? join("backups", `dev-${timestampForFilename(now)}.db`);

  mkdirSync(dirname(dest), { recursive: true });
  // copyFileSync は src が無ければ ENOENT を投げる（呼び出し側に伝播させて分かりやすく失敗）。
  copyFileSync(src, dest);

  return { src, dest };
}

// ---------------------------------------------------------------------------
// CLI ランナー（pnpm backup-db [出力パス]）
// ---------------------------------------------------------------------------

function main(): void {
  const destPath = process.argv[2];
  try {
    const { src, dest } = backupDb({ destPath });
    console.log(`backup 完了: ${src} → ${dest}`);
  } catch (error) {
    console.error("backup-db に失敗しました:", error);
    process.exitCode = 1;
  }
}

// `node scripts/backup-db.ts` で直接起動されたときだけ CLI を実行する。
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}
