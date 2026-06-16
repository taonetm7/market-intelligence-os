"use client";

import { useCallback, useEffect, useState } from "react";

import { PageHeader } from "../../components/layout/PageHeader";
import {
  DuplicatePairCard,
  pairKey,
  type DuplicatePairView,
} from "../../components/duplicate/DuplicatePairCard";

// task-35 — Duplicate Review 画面（spec v2 §9.7）。
// task-34 suggestAll（GET /api/duplicates）の似た候補ペアを一覧し、各ペアを左右に並べて
// 一致理由をハイライトする。Merge / Split は task-30 API（カード内の submitMerge / submitSplit）
// 経由・確認ダイアログを挟んで実行する。Keep Separate / Not Duplicate はサーバへ抑制を永続化する
// （POST /api/duplicates/dismiss）。いずれの操作後も一覧を再取得する。
//
// 抑制は GET /api/duplicates 側で除外される（Phase 2 / Codex 指摘2）。リロード/再訪問・再取得でも
// 復活しないため、クライアント側の一時的な除外フラグは持たない。

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

/** 重複ペアを取得する（fetcher DI）。!ok は例外。抑制済みは API 側で除外済み。 */
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

export default function DuplicatesPage() {
  const [pairs, setPairs] = useState<DuplicatePairView[]>([]);
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

  // Merge / Split / 抑制（Keep Separate / Not Duplicate）いずれも、確定後に一覧を取り直す。
  // 抑制は API 側で除外されるため、再取得すれば当該ペアは戻らない。
  const handleResolved = useCallback(() => {
    void load();
  }, [load]);

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
      {pairs.length === 0 ? (
        <p style={{ color: "#667085", fontSize: 13 }}>
          {loading ? "読み込み中…" : "重複候補ペアはありません"}
        </p>
      ) : (
        pairs.map((pair) => (
          <DuplicatePairCard key={pairKey(pair)} pair={pair} onResolved={handleResolved} />
        ))
      )}
    </>
  );
}
