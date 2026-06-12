import type { ReactNode } from "react";

import { TriageRow, type TriageSignal } from "./TriageRow";

// task-18 — Inbox Triage キュー（spec v2 §9.1 既定ランディング）。
// 「未処理 Raw Signal を捌く」日次主作業のキュー本体。一覧取得とトリアージ操作
// （Ignore / Archive / 新規候補化 / Link 起動）のロジックを純関数として切り出し、
// fetcher を DI 可能にして依存追加なしの node テストで受入基準を直接検証する。
// 描画コンポーネント（TriageQueue）は state を持たず、行と操作コールバックを並べるだけ。

export type { TriageSignal } from "./TriageRow";

// 未処理キューは task-11 の GET /api/raw-signals?unlinked=1 を使う。
// repository 側で unlinked=1 は「status inbox かつ Evidence 0 件」に固定される（未処理の定義）。
// したがってここでは unlinked=1 のみ指定すれば、処理済み（ignored/archived/link 済み）は出ない。
export const INBOX_QUEUE_URL = "/api/raw-signals?unlinked=1";

/**
 * 新規候補化で即 link する Evidence の既定値。
 * type / strength の確定はユーザーが行う作業（task-22 の link UI / task-21 の採点）だが、
 * 「作って即 link」の初期 Evidence には API 上 type と strength が必須。未レビューの初期 link が
 * スコアを過大評価しないよう strength は最小（1）にとどめ、種別は中立な "community" を既定とする
 * （§9.5 pseudo-science 化の抑制）。ユーザーは後段で type/strength を再設定する。
 */
export const PROMOTE_EVIDENCE_TYPE = "community" as const;
export const PROMOTE_STRENGTH = 1 as const;

/**
 * Raw Signal から新規 Candidate のタイトルを導く。
 * 観測対象（observedEntity）があればそれを、無ければ観測本文の先頭を使う（title は min 1 必須）。
 */
export function buildCandidateTitleFromSignal(signal: TriageSignal): string {
  const entity = signal.observedEntity?.trim();
  if (entity) return entity;
  return signal.rawText.trim().slice(0, 80) || signal.displayId;
}

/** API 共通: { data } / { error } 一貫形のうち data を取り出す。失敗は throw（呼び出し側で握る）。 */
async function readData<T>(res: Response, failMessage: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${failMessage}（${res.status}）`);
  }
  const body = (await res.json()) as { data?: T };
  return body.data as T;
}

/** 未処理キューを取得する。fetcher は DI 可能（テストで差し替える）。 */
export async function fetchInboxQueue(fetcher: typeof fetch = fetch): Promise<TriageSignal[]> {
  const res = await fetcher(INBOX_QUEUE_URL, { headers: { Accept: "application/json" } });
  const data = await readData<TriageSignal[]>(res, "キューの取得に失敗しました");
  return data ?? [];
}

/**
 * Raw Signal の status を変更する（task-11 PUT /api/raw-signals/[id]）。
 * inbox → ignored / archived。処理済みは次回取得でキューから外れる（unlinked=1 は inbox 限定）。
 */
export async function setSignalStatus(
  id: string,
  status: "ignored" | "archived",
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const res = await fetcher(`/api/raw-signals/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  await readData<unknown>(res, "ステータスの更新に失敗しました");
}

/** Ignore（status=ignored）。 */
export function ignoreSignal(id: string, fetcher: typeof fetch = fetch): Promise<void> {
  return setSignalStatus(id, "ignored", fetcher);
}

/** Archive（status=archived）。 */
export function archiveSignal(id: string, fetcher: typeof fetch = fetch): Promise<void> {
  return setSignalStatus(id, "archived", fetcher);
}

/** 新規候補化の結果（作成した Candidate と、即 link した Evidence）。 */
export type PromoteResult = {
  candidate: { id: string; displayId?: string };
  evidence: unknown;
};

/**
 * link 失敗時の補償: 作成したばかりの Candidate を退役させる
 * （DELETE /api/candidates/[id] = ソフト退役 stage=archived。hard delete はしない §7.3/§15.1）。
 * 退役できれば孤児 Candidate がアクティブに残らず、ユーザーが再試行しても重複が増えない。
 * 退役自体（DELETE）が失敗した場合は false を返し、呼び出し側が手動確認を促すメッセージを出す。
 */
async function archiveOrphanCandidate(id: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const res = await fetcher(`/api/candidates/${id}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** link 失敗時の通知文。補償（退役）の成否で文言を変え、再試行の可否を明示する。 */
function buildOrphanMessage(
  label: string,
  status: number | undefined,
  rolledBack: boolean,
): string {
  const head = status
    ? `候補への紐付けに失敗しました（${status}）`
    : "候補への紐付けに失敗しました";
  return rolledBack
    ? `${head}。作成した候補 ${label} は退役（archived）させたため重複は残りません。再試行できます。`
    : `${head}。作成した候補 ${label} の退役にも失敗しました。重複を避けるため、再試行前に候補 ${label} の状態を手動で確認してください。`;
}

/**
 * 新規候補化: Candidate を作成（task-13 POST /api/candidates）し、元の Raw Signal を
 * その場で Evidence として link する（task-12 POST /api/raw-signals/[id]/link-candidate）。
 * link 成功で Raw Signal は Evidence 1 件以上となり、次回取得でキューから外れる。
 *
 * 「作成 → 即 link」は一括操作。link が失敗すると作成済み Candidate が孤児として残り、
 * Raw Signal はキューに残るため、素朴に再試行すると重複 Candidate が増え続ける。そこで
 * link 失敗時は作成した Candidate を退役（補償）してから throw し、孤児をアクティブに残さない。
 */
export async function promoteToCandidate(
  signal: TriageSignal,
  fetcher: typeof fetch = fetch,
): Promise<PromoteResult> {
  // 1) Candidate 作成（stage は送らない＝既定 normalized。送ると API が 400 で拒否する）。
  const createRes = await fetcher("/api/candidates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: buildCandidateTitleFromSignal(signal) }),
  });
  const candidate = await readData<{ id: string; displayId?: string }>(
    createRes,
    "候補の作成に失敗しました",
  );
  const label = candidate.displayId ?? candidate.id;

  // 2) 元 Raw Signal を即 link（初期 Evidence。type/strength は後段で再設定）。
  //    readData は !ok で即 throw するため、link はここで手動判定し、失敗なら補償を挟む。
  let linkRes: Response;
  try {
    linkRes = await fetcher(`/api/raw-signals/${signal.id}/link-candidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidateId: candidate.id,
        evidenceType: PROMOTE_EVIDENCE_TYPE,
        strength: PROMOTE_STRENGTH,
      }),
    });
  } catch {
    // ネットワーク等で link 呼び出し自体が投げた場合も、作成済み Candidate を補償退役する。
    const rolledBack = await archiveOrphanCandidate(candidate.id, fetcher);
    throw new Error(buildOrphanMessage(label, undefined, rolledBack));
  }

  if (!linkRes.ok) {
    const rolledBack = await archiveOrphanCandidate(candidate.id, fetcher);
    throw new Error(buildOrphanMessage(label, linkRes.status, rolledBack));
  }

  const body = (await linkRes.json()) as { data?: { evidence: unknown } };
  return { candidate, evidence: body.data?.evidence };
}

const EMPTY_STYLE = { padding: "24px 0", color: "#667085", fontSize: 14 } as const;
const LIST_STYLE = { listStyle: "none", margin: 0, padding: 0 } as const;

export type TriageQueueProps = {
  signals: TriageSignal[];
  onLink: (signal: TriageSignal) => void;
  onPromote: (signal: TriageSignal) => void;
  onIgnore: (signal: TriageSignal) => void;
  onArchive: (signal: TriageSignal) => void;
  /** 処理中の行 id（多重送信防止でその行のボタンを無効化）。 */
  pendingId?: string | null;
  empty?: ReactNode;
};

/** 未処理キュー本体（表示専用）。各行に操作コールバックを配る。 */
export function TriageQueue({
  signals,
  onLink,
  onPromote,
  onIgnore,
  onArchive,
  pendingId,
  empty,
}: TriageQueueProps) {
  if (signals.length === 0) {
    return <p style={EMPTY_STYLE}>{empty ?? "未処理の Raw Signal はありません"}</p>;
  }
  return (
    <ul style={LIST_STYLE} aria-label="Inbox triage queue">
      {signals.map((signal) => (
        <TriageRow
          key={signal.id}
          signal={signal}
          onLink={onLink}
          onPromote={onPromote}
          onIgnore={onIgnore}
          onArchive={onArchive}
          pending={pendingId === signal.id}
        />
      ))}
    </ul>
  );
}
