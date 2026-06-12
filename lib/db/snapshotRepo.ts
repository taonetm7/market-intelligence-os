// ScoreSnapshot repository — task-28, spec v2 §7.5 / §9.9。
//
// スコアを保存するたびに ScoreSnapshot を 1 行刻み、候補ごとのスコア推移を時系列で
// 残す。週次の「上昇/低下候補」（§9.9）はこの履歴が前提になる。記録は手動ではなく
// candidateRepo.saveScores から**自動**で行う（差分が常に追えるようにする・§7.5）。
//
// 設計方針:
// - record は「ある時点の派生スコア一式（initial / detailed / signalBonus /
//   uncertaintyPenalty / confidence）＋ configVersion ＋ reason」を 1 行として刻む。
//   素点（*Inputs）は Candidate 側に保持されるためここでは持たない（履歴は派生スコアの
//   推移を追うのが目的）。
// - 自動記録を saveScores と原子的にするため、record は PrismaClient だけでなく
//   `Prisma.TransactionClient` も受け取れる（saveScores の $transaction 内から呼ぶ）。
//   record 自身は `scoreSnapshot.create` 単発で、内部で $transaction を張らない
//   （ネストを避ける）。
// - listByCandidate は新しい順（snapshotAt 降順）。snapshotAt はミリ秒精度で同一
//   トランザクション内の連続記録で同値になり得るため、第2ソートキーに `id` 降順を
//   足して決定的にする（evidenceRepo の流儀に合わせる）。
// - weekDelta は期間内の最初と最後の snapshot の差分（スコア上昇/低下）を返す。
//
// テスト容易性: 各関数は最後の引数で Prisma クライアントを差し替えられる（既定は
//   シングルトン）。テストは専用の SQLite ファイルへ向けた Client を注入する。
//
// Out of scope: 週報生成本体（task-38）/ UI 表示（task-31）。

import { type Prisma, type PrismaClient, type ScoreSnapshot } from "@prisma/client";

import { prisma } from "./client";

/**
 * repository が受け取る Prisma クライアント。
 * 自動記録を saveScores の $transaction 内から呼べるよう、フル機能の PrismaClient に
 * 加えて TransactionClient も受け付ける（record は単発 create なので両対応で十分）。
 */
export type SnapshotDb = PrismaClient | Prisma.TransactionClient;

/**
 * candidateRepo.saveScores による自動記録の reason。手動記録と区別できるよう固定値を刻む。
 */
export const SAVE_SCORES_SNAPSHOT_REASON = "saveScores";

/**
 * record の入力。`candidateId` 必須。派生スコアと configVersion / reason は任意で、
 * 未指定は `null`（その時点で値が無い）として刻む。`snapshotAt` を明示できる
 * （既定は DB の `now()`）のは、テストで時系列を決定論にするため。
 */
export interface SnapshotInput {
  candidateId: string;
  initialScore?: number | null;
  detailedScore?: number | null;
  signalBonus?: number | null;
  uncertaintyPenalty?: number | null;
  confidence?: number | null;
  configVersion?: string | null;
  reason?: string | null;
  /** 記録時刻。省略時は DB の `now()`。テストで時系列を固定するために使う。 */
  snapshotAt?: Date;
}

/**
 * weekDelta が返す、各派生スコアの期間内の増減。
 * 両端（最初/最後）の snapshot がともに値を持つフィールドのみ差分（last - first）を返し、
 * どちらかが `null` のフィールドは `null`（差分を計算できない）とする。
 */
export interface SnapshotDelta {
  initialScore: number | null;
  detailedScore: number | null;
  signalBonus: number | null;
  uncertaintyPenalty: number | null;
  confidence: number | null;
}

/**
 * weekDelta の戻り値。期間内の最初/最後の snapshot とその差分を返す。
 * - `count === 0`: 期間内に snapshot 無し（first / last は null・delta は全 null）。
 * - `count === 1`: first と last が同一行（delta は各フィールド 0 か、値が無ければ null）。
 */
export interface WeekDeltaResult {
  /** 期間内で最も古い snapshot（無ければ null）。 */
  first: ScoreSnapshot | null;
  /** 期間内で最も新しい snapshot（無ければ null）。 */
  last: ScoreSnapshot | null;
  /** 期間内の snapshot 件数。 */
  count: number;
  /** 各派生スコアの増減（last - first）。両端が値を持つフィールドのみ。 */
  delta: SnapshotDelta;
}

const SCORE_FIELDS = [
  "initialScore",
  "detailedScore",
  "signalBonus",
  "uncertaintyPenalty",
  "confidence",
] as const;

/**
 * ある時点の派生スコア一式を ScoreSnapshot として 1 行刻む（§7.5）。
 * 通常は candidateRepo.saveScores から自動で呼ばれる（手動記録も可能）。
 */
export async function record(input: SnapshotInput, db: SnapshotDb = prisma): Promise<ScoreSnapshot> {
  return db.scoreSnapshot.create({
    data: {
      candidateId: input.candidateId,
      initialScore: input.initialScore ?? null,
      detailedScore: input.detailedScore ?? null,
      signalBonus: input.signalBonus ?? null,
      uncertaintyPenalty: input.uncertaintyPenalty ?? null,
      confidence: input.confidence ?? null,
      configVersion: input.configVersion ?? null,
      reason: input.reason ?? null,
      ...(input.snapshotAt !== undefined ? { snapshotAt: input.snapshotAt } : {}),
    },
  });
}

/**
 * 指定 Candidate の snapshot を新しい順（snapshotAt 降順・id 降順）で返す。
 * snapshotAt はミリ秒精度で連続記録時に同値になり得るため、id 降順を第2キーに足して
 * 決定的にする（cuid は単調増加するため、同値時も後に作られた行が先頭に来る）。
 */
export async function listByCandidate(
  candidateId: string,
  db: SnapshotDb = prisma,
): Promise<ScoreSnapshot[]> {
  return db.scoreSnapshot.findMany({
    where: { candidateId },
    orderBy: [{ snapshotAt: "desc" }, { id: "desc" }],
  });
}

/** 両端の値がともに有限数なら差分（last - first）を、どちらか欠けるなら null を返す。 */
function diff(first: number | null, last: number | null): number | null {
  if (first === null || last === null) return null;
  return last - first;
}

/**
 * 期間内（`snapshotAt >= since`）の最初と最後の snapshot の差分を返す（§9.9 上昇/低下候補）。
 * 古い順に取り、先頭を first（期間内で最古）・末尾を last（最新）とする。期間内に snapshot が
 * 無ければ count=0・両端 null・delta 全 null。1 件のみなら first===last で delta は 0（または null）。
 */
export async function weekDelta(
  candidateId: string,
  since: Date,
  db: SnapshotDb = prisma,
): Promise<WeekDeltaResult> {
  const rows = await db.scoreSnapshot.findMany({
    where: { candidateId, snapshotAt: { gte: since } },
    orderBy: [{ snapshotAt: "asc" }, { id: "asc" }],
  });

  if (rows.length === 0) {
    return {
      first: null,
      last: null,
      count: 0,
      delta: {
        initialScore: null,
        detailedScore: null,
        signalBonus: null,
        uncertaintyPenalty: null,
        confidence: null,
      },
    };
  }

  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const delta = SCORE_FIELDS.reduce((acc, field) => {
    acc[field] = diff(first[field], last[field]);
    return acc;
  }, {} as SnapshotDelta);

  return { first, last, count: rows.length, delta };
}

/** ScoreSnapshot 操作の集約 repository。 */
export const snapshotRepo = {
  record,
  listByCandidate,
  weekDelta,
};
