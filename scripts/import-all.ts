// 全件 JSON import（復元）— task-25, spec v2 §18.4。
//
// export-all が書き出した JSON バンドルを読み込み、DB を**そのバンドルの状態へ復元**する。
// `pnpm import-all <入力パス>` で実行する。export → import → export で全件が往復一致する
// （§18.4: 全件 JSON export・import を 1 コマンドで）。
//
// 設計方針:
// - 依存を増やさない（@prisma/client のみ）。独自 loader フックは不要。
// - 破壊操作（既存全削除）を伴うため、まず auto-snapshot として削除前件数を記録して返す
//   （§18.4: bulk import 前に auto-snapshot）。フルバックアップは backup-db.ts。
// - 原子性: 全削除 → 再投入を 1 つの $transaction で実行する。不整合バンドル（FK 違反・
//   重複 id・必須欠落 等）で途中失敗しても丸ごとロールバックされ、元データが無傷で残る
//   （DB が空 / 部分復元のまま壊れることがない）。失敗時は ImportBundleError 等を再送出する。
// - 冪等: 取り込み前にコア/運用テーブルを FK 安全な順でクリアしてから入れ直す。
//   同じバンドルを 2 回取り込んでも結果は同じ（件数が増えない）。
// - id・タイムスタンプを含む全カラムを createMany でそのまま入れ、export と往復一致させる。
//   日付カラムは ISO 文字列 → Date に戻してから渡す（Prisma に正しい型で渡すため）。
//
// Out of scope: スキーマ migration / 別フォーマットからの移行。

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Prisma, PrismaClient } from "@prisma/client";

// 型のみ import（実行時に消える）。値（バージョン定数）を export-all から実行時 import すると
// Node の TS 実行で拡張子なし相対 import を解決できないため、ここでは型だけ借り、バージョンは
// 直値で持つ（export-all.ts の EXPORT_FORMAT_VERSION と一致させること）。
import type { ExportBundle } from "./export-all";

/** export-all.ts の EXPORT_FORMAT_VERSION と一致させる対応フォーマット版。 */
const EXPORT_FORMAT_VERSION = 1 as const;

/** import の結果。復元した行数と、削除前 auto-snapshot（件数）を返す。 */
export interface ImportResult {
  restored: {
    rawSignals: number;
    candidates: number;
    evidence: number;
    importBatches: number;
    quarantineRows: number;
    scoreSnapshots: number;
    decisionLogs: number;
  };
  /** auto-snapshot（§18.4）: 取り込み（全削除）前の総件数。 */
  snapshot: { totalRowsBefore: number };
}

/** バンドルの互換性を検証する明示エラー（未知の version 等）。 */
export class ImportBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportBundleError";
  }
}

/** 各テーブルで Date へ戻すカラム（ISO 文字列 → Date）。 */
const DATE_FIELDS: Record<string, readonly string[]> = {
  rawSignals: ["addedAt", "observedUpdate", "createdAt", "updatedAt"],
  candidates: ["createdAt", "updatedAt"],
  evidence: ["createdAt"],
  importBatches: ["createdAt"],
  quarantineRows: ["createdAt"],
  scoreSnapshots: ["snapshotAt"],
  decisionLogs: ["decidedAt"],
};

/** 1 行の日付カラム（ISO 文字列 or null）を Date へ復元する（その他はそのまま）。 */
function reviveDates(row: unknown, dateFields: readonly string[]): Record<string, unknown> {
  const obj = { ...(row as Record<string, unknown>) };
  for (const field of dateFields) {
    const value = obj[field];
    if (typeof value === "string") {
      obj[field] = new Date(value);
    }
  }
  return obj;
}

/** バンドルの全テーブル分の行を Date 復元する。 */
function reviveBundle(bundle: ExportBundle): Record<keyof typeof DATE_FIELDS, Record<string, unknown>[]> {
  return {
    rawSignals: bundle.rawSignals.map((r) => reviveDates(r, DATE_FIELDS.rawSignals)),
    candidates: bundle.candidates.map((r) => reviveDates(r, DATE_FIELDS.candidates)),
    evidence: bundle.evidence.map((r) => reviveDates(r, DATE_FIELDS.evidence)),
    importBatches: bundle.importBatches.map((r) => reviveDates(r, DATE_FIELDS.importBatches)),
    quarantineRows: bundle.quarantineRows.map((r) => reviveDates(r, DATE_FIELDS.quarantineRows)),
    scoreSnapshots: bundle.scoreSnapshots.map((r) => reviveDates(r, DATE_FIELDS.scoreSnapshots)),
    decisionLogs: bundle.decisionLogs.map((r) => reviveDates(r, DATE_FIELDS.decisionLogs)),
  };
}

/**
 * 既存データを FK 安全な順でクリアする。
 * Evidence→RawSignal は onDelete: Restrict のため Evidence を先に消す。
 * Candidate/ImportBatch 子テーブルは Cascade だが、件数の決定性のため明示的に先に消す。
 * トランザクションクライアント（tx）を受け取り、再投入と同一トランザクションで実行する。
 */
async function clearAll(tx: Prisma.TransactionClient): Promise<void> {
  await tx.evidence.deleteMany();
  await tx.scoreSnapshot.deleteMany();
  await tx.decisionLog.deleteMany();
  await tx.quarantineRow.deleteMany();
  await tx.candidate.deleteMany();
  await tx.rawSignal.deleteMany();
  await tx.importBatch.deleteMany();
}

/**
 * revive 済みバンドルを親 → 子 の順で createMany する（FK 制約を満たす）。
 * clearAll と同一トランザクション（tx）で実行することで、途中失敗時は全削除ごと
 * ロールバックされ、元データが無傷で残る。createMany は id・タイムスタンプ含む全カラムを
 * そのまま受け取り保存する（export と往復一致する）。revive 済みの行は構造上それぞれの
 * CreateManyInput に一致するが、JSON 由来の Record<string, unknown> なので明示キャストする。
 */
async function restoreAll(
  tx: Prisma.TransactionClient,
  data: Record<keyof typeof DATE_FIELDS, Record<string, unknown>[]>,
): Promise<void> {
  // RawSignal / Candidate / ImportBatch は他に依存しない。
  if (data.rawSignals.length > 0) {
    await tx.rawSignal.createMany({
      data: data.rawSignals as unknown as Prisma.RawSignalCreateManyInput[],
    });
  }
  if (data.candidates.length > 0) {
    await tx.candidate.createMany({
      data: data.candidates as unknown as Prisma.CandidateCreateManyInput[],
    });
  }
  if (data.importBatches.length > 0) {
    await tx.importBatch.createMany({
      data: data.importBatches as unknown as Prisma.ImportBatchCreateManyInput[],
    });
  }
  // Evidence は Candidate / RawSignal に依存。
  if (data.evidence.length > 0) {
    await tx.evidence.createMany({
      data: data.evidence as unknown as Prisma.EvidenceCreateManyInput[],
    });
  }
  // QuarantineRow は ImportBatch に依存。
  if (data.quarantineRows.length > 0) {
    await tx.quarantineRow.createMany({
      data: data.quarantineRows as unknown as Prisma.QuarantineRowCreateManyInput[],
    });
  }
  // ScoreSnapshot / DecisionLog は Candidate に依存。
  if (data.scoreSnapshots.length > 0) {
    await tx.scoreSnapshot.createMany({
      data: data.scoreSnapshots as unknown as Prisma.ScoreSnapshotCreateManyInput[],
    });
  }
  if (data.decisionLogs.length > 0) {
    await tx.decisionLog.createMany({
      data: data.decisionLogs as unknown as Prisma.DecisionLogCreateManyInput[],
    });
  }
}

/**
 * バンドルから DB を復元する。取り込み前に全削除し、親→子の順で createMany する。
 * @param bundle export-all のバンドル。
 * @param db 復元先 Prisma クライアント。省略時は DATABASE_URL のシングルトン。
 */
export async function importAll(
  bundle: ExportBundle,
  db: PrismaClient = new PrismaClient(),
): Promise<ImportResult> {
  if (bundle.version !== EXPORT_FORMAT_VERSION) {
    throw new ImportBundleError(
      `未知の export フォーマット version です: ${String(bundle.version)}（対応: ${EXPORT_FORMAT_VERSION}）`,
    );
  }

  // auto-snapshot（§18.4）: 破壊（全削除）前の総件数を記録する。
  const totalRowsBefore = await totalRowCount(db);

  const data = reviveBundle(bundle);

  // 全削除 → 再投入を 1 つのトランザクションで原子的に実行する。途中で失敗（FK 違反・
  // 重複 id・必須欠落 等）すると全削除ごとロールバックされ、元データが無傷で残る。
  await db.$transaction(async (tx) => {
    await clearAll(tx);
    await restoreAll(tx, data);
  });

  return {
    restored: {
      rawSignals: data.rawSignals.length,
      candidates: data.candidates.length,
      evidence: data.evidence.length,
      importBatches: data.importBatches.length,
      quarantineRows: data.quarantineRows.length,
      scoreSnapshots: data.scoreSnapshots.length,
      decisionLogs: data.decisionLogs.length,
    },
    snapshot: { totalRowsBefore },
  };
}

/** 全テーブルの総件数（auto-snapshot 用）。 */
async function totalRowCount(db: PrismaClient): Promise<number> {
  const counts = await Promise.all([
    db.rawSignal.count(),
    db.candidate.count(),
    db.evidence.count(),
    db.importBatch.count(),
    db.quarantineRow.count(),
    db.scoreSnapshot.count(),
    db.decisionLog.count(),
  ]);
  return counts.reduce((sum, n) => sum + n, 0);
}

// ---------------------------------------------------------------------------
// CLI ランナー（pnpm import-all <入力パス>）
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const inPath = process.argv[2];
  if (inPath === undefined) {
    console.error("使い方: pnpm import-all <入力パス.json>");
    process.exitCode = 1;
    return;
  }

  const bundle = JSON.parse(readFileSync(inPath, "utf8")) as ExportBundle;
  const db = new PrismaClient();
  try {
    const result = await importAll(bundle, db);
    const total = Object.values(result.restored).reduce((sum, n) => sum + n, 0);
    console.log(
      `import 完了: ${total} 行を復元（削除前 auto-snapshot: ${result.snapshot.totalRowsBefore} 行）`,
    );
  } finally {
    await db.$disconnect();
  }
}

// `node scripts/import-all.ts` で直接起動されたときだけ CLI を実行する。
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main().catch((error: unknown) => {
    console.error("import-all に失敗しました:", error);
    process.exitCode = 1;
  });
}
