// 人間可読 displayId の採番ユーティリティ — task-07, spec v2 §7.2 / §7.3。
//
// 実 PK は cuid（@default(cuid())）。displayId は表示専用の人間可読 ID で、
// 一覧・URL・口頭参照のために採番する。PK には一切触れない。
//
// 採番方式:
//   RawSignal: `RS-{YYYYMMDD}-{seq3}` … その日の連番（日付ごとに 001 から）
//   Candidate: `CND-{seq3}`           … 全体連番（001 から通し）
//   「既存の最大 displayId を引いて +1」方式。単一ユーザー・ローカル前提で十分。
//
// 競合回避: 採番（最大値の参照）と挿入は同一トランザクション内で行う想定のため、
//   採番関数は prisma の TransactionClient を引数で受け取る。呼び出し側が
//   `prisma.$transaction(async (tx) => { const id = await nextXxx(tx); ... })`
//   の形で採番→挿入を1トランザクションに束ねることで連番の競合を局所化する。
//
// テスト決定論性: 日付は実行時の `new Date()` に依存するため、`now: Date` を
//   引数注入できる形にする（既定は現在時刻）。
//
// Out of scope: repository への組み込み（task-08/09 が利用する）。

import { Prisma } from "@prisma/client";

/** displayId の接頭辞。 */
const RAW_SIGNAL_PREFIX = "RS";
const CANDIDATE_PREFIX = "CND";

/** 連番のゼロ埋め桁数（3桁: 001〜999）。 */
const SEQ_PAD = 3;

/**
 * 採番関数が受け取るトランザクションクライアント。
 * `PrismaClient` も `Prisma.TransactionClient` も満たすため、トランザクション
 * 内外どちらからでも呼べる（ただし競合回避のためトランザクション内利用を推奨）。
 */
export type DisplayIdClient = Prisma.TransactionClient;

/** 日付を `YYYYMMDD`（ローカル日付・8桁）に整形する。 */
function formatDate(now: Date): string {
  // ローカル日付成分で整形する（単一ローカルユーザーの「その日」= ローカル日）。
  // テストは `new Date(year, monthIndex, day)` で日付を構築すれば、CI のタイム
  // ゾーンに依存せず決定論的にこの整形を検証できる。
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // getMonth は 0 始まり。
  const day = now.getDate();
  return `${year}${pad(month, 2)}${pad(day, 2)}`;
}

/** 数値を指定桁数までゼロ埋めする。桁あふれ（>999 等）はそのまま伸長する。 */
function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * displayId 末尾の連番部分（`-` 区切りの最終要素）を数値として取り出す。
 * `RS-20260611-007` → 7、`CND-042` → 42。
 */
function parseSeq(displayId: string): number {
  const tail = displayId.split("-").pop() ?? "";
  const seq = Number.parseInt(tail, 10);
  if (Number.isNaN(seq)) {
    // 既存 displayId が想定フォーマット外（データ不整合）。採番を続行すると
    // 連番が壊れるため、原因を明示して停止する。
    throw new Error(`displayId の連番を解釈できません: "${displayId}"`);
  }
  return seq;
}

/**
 * 指定接頭辞で始まる既存 displayId のうち、連番が最大のものを +1 した次番号を返す。
 * 既存が無ければ 1。
 *
 * 連番は3桁ゼロ埋めのため、辞書順降順（orderBy desc）の先頭が連番最大に一致する
 * （001〜999 の範囲で成立。単一ローカルユーザー前提でこの範囲を超えない想定）。
 */
async function nextSeqForPrefix(
  findLatestDisplayId: (prefix: string) => Promise<string | null>,
  prefix: string,
): Promise<number> {
  const latest = await findLatestDisplayId(prefix);
  return latest ? parseSeq(latest) + 1 : 1;
}

/**
 * RawSignal の次 displayId（`RS-{YYYYMMDD}-{seq3}`）を採番する。
 * その日の既存最大連番 +1（無ければ 001）。
 *
 * @param tx 採番に用いるトランザクションクライアント（挿入と同一 tx を推奨）。
 * @param now 連番の基準日（既定は現在時刻）。テストでは固定 Date を注入する。
 */
export async function nextRawSignalDisplayId(
  tx: DisplayIdClient,
  now: Date = new Date(),
): Promise<string> {
  const prefix = `${RAW_SIGNAL_PREFIX}-${formatDate(now)}-`;
  const seq = await nextSeqForPrefix(async (p) => {
    const latest = await tx.rawSignal.findFirst({
      where: { displayId: { startsWith: p } },
      orderBy: { displayId: "desc" },
      select: { displayId: true },
    });
    return latest?.displayId ?? null;
  }, prefix);
  return `${prefix}${pad(seq, SEQ_PAD)}`;
}

/**
 * Candidate の次 displayId（`CND-{seq3}`）を採番する。
 * 全体の既存最大連番 +1（無ければ 001）。日付には依存しない通し番号。
 *
 * @param tx 採番に用いるトランザクションクライアント（挿入と同一 tx を推奨）。
 */
export async function nextCandidateDisplayId(tx: DisplayIdClient): Promise<string> {
  const prefix = `${CANDIDATE_PREFIX}-`;
  const seq = await nextSeqForPrefix(async (p) => {
    const latest = await tx.candidate.findFirst({
      where: { displayId: { startsWith: p } },
      orderBy: { displayId: "desc" },
      select: { displayId: true },
    });
    return latest?.displayId ?? null;
  }, prefix);
  return `${prefix}${pad(seq, SEQ_PAD)}`;
}
