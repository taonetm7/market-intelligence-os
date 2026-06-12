"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { PageHeader } from "../../components/layout/PageHeader";
import {
  RawSignalFilters,
  emptyRawSignalQuery,
  fetchRawSignals,
  type RawSignalQuery,
} from "../../components/raw-signal/RawSignalFilters";
import { RawSignalTable, type RawSignalRow } from "../../components/raw-signal/RawSignalTable";

// task-19 — Raw Signal 一覧画面（spec v2 §9.3）。
// Inbox（task-18）が「未処理」専用なのに対し、こちらは全件の閲覧・再編集・link 入口。
// フィルタ状態を持ち、変更のたびに API から取得し直す（取得・組立ロジックは
// components 側の純関数に切り出してテスト可能にしている）。

/**
 * 最新リクエストだけを採用するためのガード。
 * フィルタ変更で fetch を投げ直すとき、ネットワーク遅延差で古いクエリの応答が
 * 新しいクエリの応答より後に届くと一覧が古い結果で上書きされ得る（stale response）。
 * 連番トークンを発行し、応答到着時に最新トークンでなければ破棄する。
 * React 非依存の純関数なので node テストで挙動を直接検証できる。
 */
export function createLatestGuard() {
  let latest = 0;
  return {
    /** 新しいリクエストの開始。最新トークンを更新して返す。 */
    next(): number {
      latest += 1;
      return latest;
    },
    /** 渡したトークンが現時点の最新か（= その応答を採用してよいか）。 */
    isCurrent(token: number): boolean {
      return token === latest;
    },
  };
}

export default function RawSignalsPage() {
  const [query, setQuery] = useState<RawSignalQuery>(emptyRawSignalQuery);
  const [rows, setRows] = useState<RawSignalRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const guardRef = useRef(createLatestGuard());

  const load = useCallback(async (q: RawSignalQuery) => {
    const token = guardRef.current.next();
    setLoading(true);
    setError(null);
    try {
      const result = await fetchRawSignals(q);
      // 後着した古いクエリの応答なら捨てる（最新クエリの結果を保持）。
      if (!guardRef.current.isCurrent(token)) return;
      setRows(result);
    } catch (e) {
      if (!guardRef.current.isCurrent(token)) return;
      setError(e instanceof Error ? e.message : "一覧の取得に失敗しました");
      setRows([]);
    } finally {
      // 新しいリクエストが進行中なら loading は維持する。
      if (guardRef.current.isCurrent(token)) setLoading(false);
    }
  }, []);

  // 入力（検索文字など）の連打を 200ms で束ね、過剰なリクエストを避ける。
  useEffect(() => {
    const timer = setTimeout(() => {
      void load(query);
    }, 200);
    return () => clearTimeout(timer);
  }, [query, load]);

  return (
    <>
      <PageHeader
        title="Raw Signals"
        description="取り込んだ生シグナルの全件一覧。フィルタ・検索で絞り込み、行から編集・link へ。"
      />
      <RawSignalFilters value={query} onChange={setQuery} />
      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13 }}>
          {error}
        </p>
      ) : null}
      <RawSignalTable rows={rows} empty={loading ? "読み込み中…" : "Raw Signal がありません"} />
    </>
  );
}
