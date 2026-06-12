"use client";

import { useCallback, useEffect, useState } from "react";

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
export default function RawSignalsPage() {
  const [query, setQuery] = useState<RawSignalQuery>(emptyRawSignalQuery);
  const [rows, setRows] = useState<RawSignalRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (q: RawSignalQuery) => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchRawSignals(q));
    } catch (e) {
      setError(e instanceof Error ? e.message : "一覧の取得に失敗しました");
      setRows([]);
    } finally {
      setLoading(false);
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
