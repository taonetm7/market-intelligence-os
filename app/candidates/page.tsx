"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { PageHeader } from "../../components/layout/PageHeader";
import {
  CandidateFilters,
  emptyCandidateQuery,
  fetchCandidates,
  type CandidateQuery,
} from "../../components/candidate/CandidateFilters";
import { CandidateTable, type CandidateRow } from "../../components/candidate/CandidateTable";

// task-20 — Candidate 一覧画面（spec v2 §9.4）。
// stage 別フィルタ・Top100 ビュー切替・ユーザー選択ソート。フィルタ変更のたびに
// API から取得し直す（組立・取得・絞り込みは components 側の純関数に切り出し済み）。
//
// 設計上の重要点（§9.4 冒頭注「pseudo-science 化の抑制」§9.5）:
//   既定ソートはスコア単独にしない（過信防止）。既定は updatedAt（CandidateFilters の
//   DEFAULT_SORT_BY）。スコア（initialScore / detailedScore）は明示選択時のみ。
//   confidence はスコアと別カラムで併置表示する（CandidateTable）。

/**
 * 最新リクエストだけを採用する連番ガード（stale response 対策）。
 * フィルタ変更で fetch を投げ直すと、ネットワーク遅延差で古いクエリの応答が新しい
 * クエリの応答より後に届き、一覧が古い結果で上書きされ得る。連番トークンを発行し、
 * 応答到着時に最新トークンでなければ破棄する。
 * task-19（app/raw-signals/page.tsx）と同一意図。共有ライブラリ化は本タスクの
 * write scope 外（指示役確認が必要）のため、ここでも局所定義する。React 非依存の
 * 純関数なので node テストで挙動を直接検証できる。
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

export default function CandidatesPage() {
  const [query, setQuery] = useState<CandidateQuery>(emptyCandidateQuery);
  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const guardRef = useRef(createLatestGuard());

  const load = useCallback(async (q: CandidateQuery) => {
    const token = guardRef.current.next();
    setLoading(true);
    setError(null);
    try {
      const result = await fetchCandidates(q);
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

  // 入力（数値・テキスト）の連打を 200ms で束ね、過剰なリクエストを避ける。
  useEffect(() => {
    const timer = setTimeout(() => {
      void load(query);
    }, 200);
    return () => clearTimeout(timer);
  }, [query, load]);

  return (
    <>
      <PageHeader
        title="Candidates"
        description="シグナルから昇格した候補の一覧。stage で絞り込み、Top100 ビューでゲート通過を確認。"
      />
      <CandidateFilters value={query} onChange={setQuery} />
      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13 }}>
          {error}
        </p>
      ) : null}
      <CandidateTable rows={rows} empty={loading ? "読み込み中…" : "Candidate がありません"} />
    </>
  );
}
