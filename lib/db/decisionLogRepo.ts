// DecisionLog repository — task-29, spec v2 §7.6 / §15.2 / §15.3。
//
// 判断ログ（promote / demote / reject / merge / split / hold / スコア変更）を 1 行ずつ
// 刻み、「なぜその判断をしたか」を後から見直せるようにする（§15.3）。merge / split の
// 相手候補は relatedCandidateId に残す（§15.2）。UI / API route は Prisma を直接触らず、
// 必ずこの repository（と candidateMerge）を経由する。
//
// 設計方針:
// - enum（decisionType / fromStage / toStage）と必須 reason は task-02 の
//   `decisionInputSchema` で検証する（文字列直書き禁止）。入力は入口で必ず parse する。
// - reason は必須（§7.6 / §15.3）。空文字は Zod が弾く＝理由無しの判断は記録できない。
// - 自動記録を candidateMerge の merge/split の $transaction 内から呼べるよう、log は
//   PrismaClient だけでなく `Prisma.TransactionClient` も受け取れる（log 自身は単発
//   create で内部に $transaction を張らないため、ネストを避けつつ tx 内から使える）。
// - listByCandidate は新しい順（decidedAt 降順）。decidedAt はミリ秒精度で同一
//   トランザクション内の連続記録（merge は両者へ 2 件刻む）で同値になり得るため、
//   第2ソートキーに `id` 降順を足して決定的にする（既存 repo の tie-break 流儀に合わせる）。
//
// テスト容易性: 各関数は最後の引数で Prisma クライアントを差し替えられる（既定は
//   シングルトン）。`decidedAt` を明示できる（既定は DB の `now()`）のは、テストで
//   時系列を決定論にするため（snapshotRepo.record の snapshotAt と同じ流儀）。
//
// Out of scope: merge / split の意味論本体（candidateMerge）/ UI（task-31）/ API route。

import { type DecisionLog, type Prisma, type PrismaClient } from "@prisma/client";

import { decisionInputSchema, type DecisionInput } from "../validation/schemas";
import { prisma } from "./client";

/**
 * repository が受け取る Prisma クライアント。
 * merge / split の $transaction 内から自動記録できるよう、フル機能の PrismaClient に
 * 加えて TransactionClient も受け付ける（log は単発 create なので両対応で十分）。
 */
export type DecisionLogDb = PrismaClient | Prisma.TransactionClient;

/**
 * log の入力。共有の `decisionInputSchema`（candidateId / decisionType / fromStage? /
 * toStage? / relatedCandidateId? / reason必須）に、テストで時系列を固定するための
 * `decidedAt`（既定は DB の `now()`）を任意で添えられる。decidedAt は Zod スキーマには
 * 含めず、log の入口で分離して扱う（スキーマは正本のまま触らない）。
 */
export type DecisionLogInput = DecisionInput & {
  /** 判断時刻。省略時は DB の `now()`。テストで時系列を固定するために使う。 */
  decidedAt?: Date;
};

/**
 * 判断ログを 1 行刻む（§7.6 / §15.3）。reason は必須（空文字は Zod が弾く）。
 * merge / split からは relatedCandidateId に相手候補 ID を入れて呼ばれる（§15.2）。
 */
export async function log(input: DecisionLogInput, db: DecisionLogDb = prisma): Promise<DecisionLog> {
  const { decidedAt, ...rest } = input;
  const data = decisionInputSchema.parse(rest);
  return db.decisionLog.create({
    data: {
      candidateId: data.candidateId,
      decisionType: data.decisionType,
      fromStage: data.fromStage ?? null,
      toStage: data.toStage ?? null,
      relatedCandidateId: data.relatedCandidateId ?? null,
      reason: data.reason,
      ...(decidedAt !== undefined ? { decidedAt } : {}),
    },
  });
}

/**
 * 指定 Candidate の判断ログを新しい順（decidedAt 降順・id 降順）で返す。
 * decidedAt はミリ秒精度で連続記録時に同値になり得るため、id 降順を第2キーに足して
 * 決定的にする（cuid は単調増加するため、同値時も後に作られた行が先頭に来る）。
 */
export async function listByCandidate(
  candidateId: string,
  db: DecisionLogDb = prisma,
): Promise<DecisionLog[]> {
  return db.decisionLog.findMany({
    where: { candidateId },
    orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
  });
}

/** DecisionLog 操作の集約 repository。 */
export const decisionLogRepo = {
  log,
  listByCandidate,
};
