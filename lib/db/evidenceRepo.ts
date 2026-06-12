// Evidence repository — task-10, spec v2 §7.4 / §8.2 / §8.6。
//
// Evidence は「RawSignal を Candidate に link する純粋な join」として実装する。
// 独立した Evidence 作成は提供しない（一次ソース無しの証拠を作れない）。UI / API
// route（task-12）は Prisma を直接触らず、必ずこの repository を経由する。
//
// 設計方針:
// - enum（evidenceType）と素点（strength / credibility）は task-02 の Zod スキーマ
//   （evidenceLinkInputSchema）で検証する。入力は repository の入口で必ず parse する。
// - link は rawSignalId 必須（§7.4 一次ソース）。型レベル（引数型 EvidenceLinkArgs が
//   rawSignalId: string を要求）と実行時（Zod が min(1) で弾く）の両面で、一次ソース無し
//   の証拠生成を構造的に塞ぐ。
// - 同一 (candidate, rawSignal, evidenceType) の重複 link は DB の
//   `@@unique([candidateId, rawSignalId, evidenceType])` で禁止する。Prisma の P2002 を
//   捕捉し、呼び出し側が扱える明確なエラー（EvidenceDuplicateLinkError）へ翻訳する。
// - signalStatsByCandidate は Evidence×RawSignal を join し、ゲート/confidence の核に
//   なる集計（distinct sourceType・平均 strength・直接支出有無・最新観測時刻・強シグナル
//   種別）を返す（§8.2 / §8.6、task-05/06/13 が利用）。
//
// テスト容易性: 各関数は最後の引数で Prisma クライアントを差し替えられる（既定は
//   シングルトン）。テストは専用の SQLite ファイルへ向けた Client を注入する。
//
// 退役の扱い: link/unlink のみを提供し update は持たない（証拠は付け外しで表現する）。
//   よって task-08/09 のような「partial() で default が materialize する」迂回路は
//   この層には存在しない。
//
// Out of scope: API route（task-12）/ UI（task-22）/ スコア計算本体（task-04〜06）。

import { type Evidence, Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

import { evidenceLinkInputSchema } from "../validation/schemas";
import type { EvidenceType } from "../validation/enums";
import { prisma } from "./client";

/**
 * repository が受け取る Prisma クライアント。
 * 既存 repo に倣いフル機能の PrismaClient を要求する（テストで差し替え可能）。
 */
export type EvidenceDb = PrismaClient;

/**
 * link の引数型。`z.input` を使い、default を持つ `credibility` と任意の `note` を
 * 省略可能にする一方で、`candidateId` / `rawSignalId` / `evidenceType` / `strength` は
 * 必須として要求する。これにより rawSignalId 無しの link を型レベルで弾く（§7.4）。
 */
export type EvidenceLinkArgs = z.input<typeof evidenceLinkInputSchema>;

/**
 * 強シグナル種別（§8.2）。需要の核となる evidenceType の集合。
 * `signalStatsByCandidate.strongSignalTypes` はこの集合のうち実在するものを返す。
 */
export const STRONG_SIGNAL_TYPES = ["spend", "dissatisfaction", "search"] as const;

/**
 * signalStatsByCandidate の戻り値（§8.2 / §8.6 ゲート・confidence の核）。
 * - distinctSourceTypes: 紐付く RawSignal の sourceType 異なり数（多面性の指標）。
 * - avgStrength: Evidence.strength の平均（証拠 0 件なら 0）。
 * - hasDirectSpend: evidenceType に `spend`（直接支出）が含まれるか。
 * - latestObservedAt: 紐付く RawSignal の最新観測時刻（observedUpdate の最大、無ければ null）。
 * - strongSignalTypes: 実在する強シグナル種別（{spend, dissatisfaction, search} の部分集合）。
 */
export interface CandidateSignalStats {
  distinctSourceTypes: number;
  avgStrength: number;
  hasDirectSpend: boolean;
  latestObservedAt: Date | null;
  strongSignalTypes: Set<EvidenceType>;
}

/**
 * 同一 (candidate, rawSignal, evidenceType) の重複 link を表す明確なエラー。
 * Prisma の P2002（unique 制約違反）を呼び出し側が扱える形へ翻訳する。
 */
export class EvidenceDuplicateLinkError extends Error {
  constructor(
    public readonly candidateId: string,
    public readonly rawSignalId: string,
    public readonly evidenceType: string,
  ) {
    super(
      `Evidence already links candidate=${candidateId} rawSignal=${rawSignalId} ` +
        `evidenceType=${evidenceType}（同一の証拠種別で既に紐付け済み）`,
    );
    this.name = "EvidenceDuplicateLinkError";
  }
}

/**
 * RawSignal を Candidate に link して Evidence を 1 件作成する。
 * 入力を Zod 検証（rawSignalId 必須・evidenceType/素点を検証）してから挿入する。
 * 同一 (candidate, rawSignal, evidenceType) が既存なら EvidenceDuplicateLinkError を投げる。
 */
export async function link(
  input: EvidenceLinkArgs,
  db: EvidenceDb = prisma,
): Promise<Evidence> {
  const data = evidenceLinkInputSchema.parse(input);
  try {
    return await db.evidence.create({
      data: {
        candidateId: data.candidateId,
        rawSignalId: data.rawSignalId,
        evidenceType: data.evidenceType,
        strength: data.strength,
        credibility: data.credibility,
        note: data.note,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new EvidenceDuplicateLinkError(
        data.candidateId,
        data.rawSignalId,
        data.evidenceType,
      );
    }
    throw error;
  }
}

/** id で Evidence（link）を 1 件削除する。 */
export async function unlink(id: string, db: EvidenceDb = prisma): Promise<void> {
  await db.evidence.delete({ where: { id } });
}

/**
 * 指定 Candidate に紐付く Evidence を返す（新しい順）。
 * 表示・集計の起点。RawSignal の中身が必要な集計は signalStatsByCandidate を使う。
 */
export async function listByCandidate(
  candidateId: string,
  db: EvidenceDb = prisma,
): Promise<Evidence[]> {
  return db.evidence.findMany({
    where: { candidateId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * 指定 Candidate のシグナル集計を返す（§8.2 / §8.6）。
 * Evidence×RawSignal を join し、ゲート/confidence の核になる指標を算出する。
 * distinctSourceTypes は RawSignal.sourceType で重複排除する（同一 sourceType の複数証拠は 1）。
 */
export async function signalStatsByCandidate(
  candidateId: string,
  db: EvidenceDb = prisma,
): Promise<CandidateSignalStats> {
  const rows = await db.evidence.findMany({
    where: { candidateId },
    include: { rawSignal: true },
  });

  const sourceTypes = new Set<string>();
  const strongSignalTypes = new Set<EvidenceType>();
  let strengthSum = 0;
  let hasDirectSpend = false;
  let latestObservedAt: Date | null = null;

  for (const row of rows) {
    sourceTypes.add(row.rawSignal.sourceType);
    strengthSum += row.strength;
    if (row.evidenceType === "spend") {
      hasDirectSpend = true;
    }
    if ((STRONG_SIGNAL_TYPES as readonly string[]).includes(row.evidenceType)) {
      strongSignalTypes.add(row.evidenceType as EvidenceType);
    }
    const observedAt = row.rawSignal.observedUpdate;
    if (observedAt !== null && (latestObservedAt === null || observedAt > latestObservedAt)) {
      latestObservedAt = observedAt;
    }
  }

  return {
    distinctSourceTypes: sourceTypes.size,
    avgStrength: rows.length === 0 ? 0 : strengthSum / rows.length,
    hasDirectSpend,
    latestObservedAt,
    strongSignalTypes,
  };
}

/** Evidence 操作の集約 repository。 */
export const evidenceRepo = {
  link,
  unlink,
  listByCandidate,
  signalStatsByCandidate,
};
