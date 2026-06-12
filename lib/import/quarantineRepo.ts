// Import quarantine repository — task-15, spec v2 §10.1 / §11.2。
//
// import 行を即本登録せず、まず QuarantineRow に隔離し、人間の accept で初めて
// RawSignal へ本登録する「関門」。AI/外部由来データの幻覚・誤りが DB を汚染するのを防ぐ
// （§11.2: AI 出力は必ず origin="ai" で quarantine → 人間 accept）。
//
// 設計方針:
// - parse 本体（lib/import/parse.ts, task-14）と本登録（lib/db/rawSignalRepo.ts, task-08）を
//   再利用し、ここでは「隔離テーブルへの永続化」と「accept の遷移」だけを担う（重複定義しない）。
// - valid 行は payloadJson（RawSignalInput）として、invalid 行は errorsJson（理由配列）として
//   隔離する。失敗行を捨てない（§10.1 step6）。
// - batch の origin（import | ai）を valid 行の payload に焼き込み、accept で作られる
//   RawSignal に origin が必ず付くようにする（§10.1 step4 / §11.2）。
// - accept は pending 行のみを本登録する。invalid 行は accept 不可（明示エラー）。
// - 破壊操作前 auto-snapshot（v2 §18.4）の最小実装として、accept 前後の RawSignal 件数を
//   記録して返す。フル backup（DB コピー / 全件 export）は task-25。
//
// テスト容易性: 各関数は最後の引数で Prisma クライアントを差し替えられる（既定は
//   シングルトン）。テストは専用の SQLite ファイルへ向けた Client を注入する。
//
// Out of scope: UI（task-23）/ AI 専用フロー（Slice 5 task-35）/ フル backup（task-25）。

import type { ImportBatch, PrismaClient, QuarantineRow } from "@prisma/client";

import { rawSignalRepo, type RawSignalRecord } from "../db/rawSignalRepo";
import { prisma } from "../db/client";
import { originSchema } from "../validation/enums";
import { serializeJsonField, type RawSignalInput } from "../validation/schemas";
import type { ParseResult } from "./parse";

/** repository が受け取る Prisma クライアント（accept でトランザクションを張るためフル機能を要求）。 */
export type QuarantineDb = PrismaClient;

/** バッチの来歴。import（外部取り込み既定）か ai（AI 由来・§11.2）。manual は不可。 */
export const batchOriginSchema = originSchema.exclude(["manual"]);
export type BatchOrigin = (typeof batchOriginSchema)["_output"];

/** import 受領フォーマット。 */
export const BATCH_FORMAT_VALUES = ["json", "csv"] as const;
export type BatchFormat = (typeof BATCH_FORMAT_VALUES)[number];

/** バッチ作成の入力。origin 既定 import、format は parse 元（json/csv）。 */
export interface CreateBatchInput {
  origin?: BatchOrigin;
  format: BatchFormat;
  note?: string;
}

/** import 結果。作成した batch と、隔離された行を status 別に分けて返す。 */
export interface QuarantineImportResult {
  batch: ImportBatch;
  pending: QuarantineRow[];
  invalid: QuarantineRow[];
}

/** 一覧の 1 バッチ分。行を status 別に束ねて返す（§10.1 step5 の確認 UI 用）。 */
export interface QuarantineBatchView {
  batch: ImportBatch;
  pending: QuarantineRow[];
  invalid: QuarantineRow[];
  accepted: QuarantineRow[];
}

/** accept の結果。本登録された RawSignal と、auto-snapshot（件数記録）を返す。 */
export interface QuarantineAcceptResult {
  accepted: Array<{ row: QuarantineRow; rawSignal: RawSignalRecord }>;
  /** auto-snapshot（v2 §18.4 最小実装）: accept 前後の RawSignal 総件数。 */
  snapshot: {
    rawSignalCountBefore: number;
    acceptedCount: number;
    rawSignalCountAfter: number;
  };
}

/** invalid 行を accept しようとしたときに投げる明示エラー（§10.1: 失敗行は本登録不可）。 */
export class QuarantineInvalidRowError extends Error {
  constructor(public readonly rowIds: string[]) {
    super(
      `invalid な隔離行は本登録できません（accept 不可）: ${rowIds.join(", ")}`,
    );
    this.name = "QuarantineInvalidRowError";
  }
}

/**
 * 既に accepted 済みの行を rowIds で明示 accept しようとしたときに投げる明示エラー
 * （Codex 指摘1: 再 accept を成功扱いにしない。route 側で 409 に翻訳する）。
 * 注意: rowIds 省略の「pending 全行 accept」は冪等な利便機能なのでこのエラーは投げない
 * （pending だけを対象にするため、accepted 行は元々対象外）。本エラーは「この行を本登録せよ」
 * と明示指定したのに既に本登録済み、という矛盾要求だけを弾く。
 */
export class QuarantineAlreadyAcceptedError extends Error {
  constructor(public readonly rowIds: string[]) {
    super(`既に本登録済みの隔離行は再 accept できません: ${rowIds.join(", ")}`);
    this.name = "QuarantineAlreadyAcceptedError";
  }
}

/** バッチ / 行が見つからないときの明示エラー（route 側で 404 に翻訳する）。 */
export class QuarantineNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuarantineNotFoundError";
  }
}

/** 行を status 別に束ねる内部ヘルパ。 */
function groupByStatus(rows: QuarantineRow[]): {
  pending: QuarantineRow[];
  invalid: QuarantineRow[];
  accepted: QuarantineRow[];
} {
  return {
    pending: rows.filter((r) => r.status === "pending"),
    invalid: rows.filter((r) => r.status === "invalid"),
    accepted: rows.filter((r) => r.status === "accepted"),
  };
}

/**
 * parse 結果（task-14）を 1 バッチとして隔離する。
 * valid 行は payload（RawSignalInput）を batch の origin で上書きしてから pending に、
 * invalid 行は理由付きで invalid に格納する。origin を焼き込むことで、accept で作られる
 * RawSignal に必ず origin が付く（既定 import、AI 経由は ai。§10.1 step4 / §11.2）。
 */
export async function createBatchFromParse(
  parsed: ParseResult,
  input: CreateBatchInput,
  db: QuarantineDb = prisma,
): Promise<QuarantineImportResult> {
  const origin = batchOriginSchema.parse(input.origin ?? "import");

  const batch = await db.importBatch.create({
    data: { origin, format: input.format, note: input.note },
  });

  // valid 行: payload の origin を batch の origin に揃える（本登録時の来歴を確定）。
  // rowNumber は parse が付けた元入力行番号を使う（valid 配列順ではなく、invalid 混在時も
  // 元ファイル/入力と突合できる・Codex 指摘3）。row は payload から外して本体に混ぜない。
  const validData = parsed.valid.map(({ row, ...payload }) => ({
    batchId: batch.id,
    rowNumber: row,
    status: "pending",
    payloadJson: serializeJsonField({ ...payload, origin } satisfies RawSignalInput),
  }));

  // invalid 行: パーサの行番号と理由を保持（失敗行を捨てない・§10.1 step6）。
  const invalidData = parsed.invalid.map((row) => ({
    batchId: batch.id,
    rowNumber: row.row,
    status: "invalid",
    errorsJson: serializeJsonField(row.errors),
  }));

  // createMany は SQLite でも使えるが返り値が件数のみのため、作成後に読み戻して行を返す。
  if (validData.length > 0 || invalidData.length > 0) {
    await db.quarantineRow.createMany({ data: [...validData, ...invalidData] });
  }

  const rows = await listRowsByBatch(batch.id, db);
  const grouped = groupByStatus(rows);
  return { batch, pending: grouped.pending, invalid: grouped.invalid };
}

/** 1 バッチの行を決定的な順序で返す（rowNumber 昇順 → id 昇順の tie-break。task-14b 教訓）。 */
async function listRowsByBatch(
  batchId: string,
  db: QuarantineDb = prisma,
): Promise<QuarantineRow[]> {
  return db.quarantineRow.findMany({
    where: { batchId },
    orderBy: [{ rowNumber: "asc" }, { id: "asc" }],
  });
}

/**
 * 隔離一覧を返す（§10.1 step5）。batch 単位で pending / invalid / accepted を束ねる。
 * batchId 指定時はそのバッチのみ。並びは新しいバッチが先頭（createdAt 降順 → id 降順の
 * tie-break で決定的。task-14b 教訓）。
 */
export async function listQuarantine(
  batchId?: string,
  db: QuarantineDb = prisma,
): Promise<QuarantineBatchView[]> {
  const batches = await db.importBatch.findMany({
    where: batchId ? { id: batchId } : undefined,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      rows: { orderBy: [{ rowNumber: "asc" }, { id: "asc" }] },
    },
  });

  return batches.map(({ rows, ...batch }) => {
    const grouped = groupByStatus(rows);
    return { batch, ...grouped };
  });
}

/**
 * 選択された pending 行を RawSignal へ本登録する（§10.1 step5）。
 * rowIds 省略時はバッチの pending 全行を対象にする。invalid 行が対象に含まれていれば
 * 本登録せず QuarantineInvalidRowError を投げる（accept 不可）。accepted（再 accept）は
 * 冪等にスキップする。
 *
 * auto-snapshot（v2 §18.4 最小実装）: accept 前後の RawSignal 総件数を記録して返す。
 * 各行の本登録は rawSignalRepo.create（task-08）に委ね、成功後に行を accepted へ遷移し
 * rawSignalId を記録する（本登録の証跡）。
 *
 * 原子性（Codex 指摘2）: rawSignalRepo.create は内部で自前の $transaction を張るため
 * 外側の対話的トランザクションにネストできず（Prisma の TransactionClient は $transaction を
 * 持たない）、また repo の API は変更しない制約がある。そこで repo API を変えない範囲で
 * 「本登録 → 行更新」を best-effort に原子化する:
 *  - 行更新は updateMany の where に status:"pending" を含め、並行 accept 等で既に pending で
 *    なくなっていれば 0 件更新として検出する（重複本登録を防ぐ並行ガード）。
 *  - 更新が 0 件 / 例外のときは、直前に作成した RawSignal を補償削除し、「RawSignal だけ存在し
 *    行は pending のまま」という不整合を残さない。
 */
export async function accept(
  batchId: string,
  rowIds: string[] | undefined,
  db: QuarantineDb = prisma,
): Promise<QuarantineAcceptResult> {
  const batch = await db.importBatch.findUnique({ where: { id: batchId } });
  if (batch === null) {
    throw new QuarantineNotFoundError(`ImportBatch が見つかりません: ${batchId}`);
  }

  const allRows = await listRowsByBatch(batchId, db);

  // 対象行を決める。明示 rowIds はそのバッチ内に存在しなければ 404 相当。
  let targets: QuarantineRow[];
  if (rowIds === undefined) {
    targets = allRows.filter((r) => r.status === "pending");
  } else {
    const byId = new Map(allRows.map((r) => [r.id, r]));
    const missing = rowIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new QuarantineNotFoundError(
        `指定の隔離行がバッチ ${batchId} に存在しません: ${missing.join(", ")}`,
      );
    }
    targets = rowIds.map((id) => byId.get(id)!);
  }

  // invalid 行は accept 不可（明示エラー）。§10.1: 失敗行は本登録できない。
  const invalidTargets = targets.filter((r) => r.status === "invalid");
  if (invalidTargets.length > 0) {
    throw new QuarantineInvalidRowError(invalidTargets.map((r) => r.id));
  }

  // 明示 rowIds で accepted 済みの行を指定したら矛盾要求として弾く（Codex 指摘1）。
  // rowIds 省略時の「pending 全行 accept」は冪等な利便機能なのでこの検査はしない
  // （pending だけが対象となり accepted 行は元々除外される）。
  if (rowIds !== undefined) {
    const acceptedTargets = targets.filter((r) => r.status === "accepted");
    if (acceptedTargets.length > 0) {
      throw new QuarantineAlreadyAcceptedError(acceptedTargets.map((r) => r.id));
    }
  }

  // pending のみ本登録。
  const pendingTargets = targets.filter((r) => r.status === "pending");

  // auto-snapshot（§18.4 最小実装）: 本登録前の総件数を記録。
  const rawSignalCountBefore = await db.rawSignal.count();

  const accepted: QuarantineAcceptResult["accepted"] = [];
  for (const row of pendingTargets) {
    const payload = JSON.parse(row.payloadJson ?? "{}") as RawSignalInput;
    const rawSignal = await rawSignalRepo.create(payload, db);

    // 行更新（pending → accepted）。並行ガードとして where に status:"pending" を含める。
    // 例外/0 件更新時は作成済み RawSignal を補償削除し不整合を残さない（Codex 指摘2）。
    let updatedCount: number;
    try {
      const res = await db.quarantineRow.updateMany({
        where: { id: row.id, status: "pending" },
        data: { status: "accepted", rawSignalId: rawSignal.id },
      });
      updatedCount = res.count;
    } catch (error) {
      await rawSignalRepo.delete(rawSignal.id, db);
      throw error;
    }
    if (updatedCount === 0) {
      // 並行して既に accept 済み等で pending でなくなっていた → 重複本登録を取り消す。
      await rawSignalRepo.delete(rawSignal.id, db);
      continue;
    }

    accepted.push({ row: { ...row, status: "accepted", rawSignalId: rawSignal.id }, rawSignal });
  }

  const rawSignalCountAfter = await db.rawSignal.count();

  return {
    accepted,
    snapshot: {
      rawSignalCountBefore,
      acceptedCount: accepted.length,
      rawSignalCountAfter,
    },
  };
}

/** quarantine 操作の集約 repository。 */
export const quarantineRepo = {
  createBatchFromParse,
  listQuarantine,
  accept,
};
