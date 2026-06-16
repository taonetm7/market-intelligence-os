"use client";

import { useCallback, useEffect, useState } from "react";

import { PageHeader } from "../../components/layout/PageHeader";
import {
  DuplicatePairCard,
  pairKey,
  type DuplicatePairView,
  type PairAction,
} from "../../components/duplicate/DuplicatePairCard";

// task-35 — Duplicate Review 画面（spec v2 §9.7）。
// task-34 suggestAll（GET /api/duplicates）の似た候補ペアを一覧し、各ペアを左右に並べて
// 一致理由をハイライトする。Merge / Split は task-30 API（カード内の submitMerge / submitSplit）
// 経由で実行し、成功後に一覧を再取得する。Keep Separate / Not Duplicate はサジェストから
// 抑制（最小実装＝クライアント側で一覧から除外。永続化はモデル追加が要るため別タスク）。

/** 重複ペア一覧 API のエンドポイント。 */
export const DUPLICATES_ENDPOINT = "/api/duplicates";

/** 一覧取得の任意クエリ（閾値 / 上限。未指定は repository 既定）。 */
export interface DuplicatesQuery {
  threshold?: number;
  limit?: number;
}

/** クエリを取得 URL へ畳む（未指定パラメータは付けない）。 */
export function buildDuplicatesUrl(query: DuplicatesQuery = {}): string {
  const params = new URLSearchParams();
  if (query.threshold !== undefined) params.set("threshold", String(query.threshold));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return qs ? `${DUPLICATES_ENDPOINT}?${qs}` : DUPLICATES_ENDPOINT;
}

/** 重複ペアを取得する（fetcher DI）。!ok は例外。 */
export async function fetchDuplicatePairs(
  query: DuplicatesQuery = {},
  fetcher: typeof fetch = fetch,
): Promise<DuplicatePairView[]> {
  const res = await fetcher(buildDuplicatesUrl(query));
  if (!res.ok) {
    throw new Error(`重複ペアの取得に失敗しました（${res.status}）`);
  }
  const body = (await res.json()) as { data: DuplicatePairView[] };
  return body.data;
}

/** 抑制（Keep Separate / Not Duplicate）したペアを除いた表示対象。 */
export function visiblePairs(
  pairs: DuplicatePairView[],
  dismissed: ReadonlySet<string>,
): DuplicatePairView[] {
  return pairs.filter((p) => !dismissed.has(pairKey(p)));
}

/** Merge / Split は再取得を要するアクション（候補のステージが変わるため）。 */
export function isRefetchAction(action: PairAction): boolean {
  return action === "merge" || action === "split";
}

export default function DuplicatesPage() {
  const [pairs, setPairs] = useState<DuplicatePairView[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPairs(await fetchDuplicatePairs());
    } catch (e) {
      setError(e instanceof Error ? e.message : "一覧の取得に失敗しました");
      setPairs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 同期的な setState（loading 立ち上げ）を effect 本体から外すため一拍遅らせる
  // （react-hooks/set-state-in-effect 回避・app/candidates/page.tsx と同じ流儀）。
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const handleResolved = useCallback(
    (action: PairAction, pair: DuplicatePairView) => {
      if (isRefetchAction(action)) {
        // Merge / Split 後はステージ変化で当該ペアが消えるため、一覧を取り直す。
        void load();
      } else {
        // Keep Separate / Not Duplicate はクライアント側でこのペアを抑制する。
        setDismissed((prev) => {
          const next = new Set(prev);
          next.add(pairKey(pair));
          return next;
        });
      }
    },
    [load],
  );

  const visible = visiblePairs(pairs, dismissed);

  return (
    <>
      <PageHeader
        title="Duplicate Review"
        description="似た候補ペアを確認し、統合 / 分割 / 別物として残す / 重複でない を判断します（§9.7）。"
      />
      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13 }}>
          {error}
        </p>
      ) : null}
      {visible.length === 0 ? (
        <p style={{ color: "#667085", fontSize: 13 }}>
          {loading ? "読み込み中…" : "重複候補ペアはありません"}
        </p>
      ) : (
        visible.map((pair) => (
          <DuplicatePairCard key={pairKey(pair)} pair={pair} onResolved={handleResolved} />
        ))
      )}
    </>
  );
}
