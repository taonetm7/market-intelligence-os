"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Table, type Column } from "../ui";
import { createLatestGuard } from "./CandidateDetail";
import { formatConfidence, formatScore } from "./CandidateTable";

// task-31 — ScoreSnapshot 履歴（spec v2 §7.5 / §9.9）。
// 候補のスコア推移（saveScores のたびに自動記録される ScoreSnapshot・task-28）を時系列の表で
// 表示する。取得は GET /api/scoring/snapshots/[candidateId]（task-30）を薄く叩くだけ。
//
// 設計（既存 UI の流儀）: 取得は純関数（fetcher DI）に切り出し、表示は state を持たないビューに分け
// renderToStaticMarkup で検証する。スコアと confidence は別カラムで併置し（§9.4/§9.5: 評価を
// 1 つの数字へ潰さない）、CandidateTable と同じ整形関数を使って一覧と表示を一貫させる。

/**
 * ScoreSnapshot 1 行の表示形（GET /api/scoring/snapshots/[candidateId] の data 要素）。
 * Response.json が Date を ISO 文字列へ直列化するため snapshotAt は string。
 */
export type ScoreSnapshotRow = {
  id: string;
  snapshotAt: string;
  initialScore: number | null;
  detailedScore: number | null;
  signalBonus: number | null;
  uncertaintyPenalty: number | null;
  confidence: number | null;
  configVersion: string | null;
  reason: string | null;
};

/**
 * ISO 文字列を「YYYY-MM-DD HH:mm」へ整形する（UTC のまま・locale 非依存で決定的）。
 * 解析できない値はそのまま返す（防御）。
 */
export function formatSnapshotAt(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return m ? `${m[1]} ${m[2]}` : value;
}

/** ScoreSnapshot の endpoint（task-30）。 */
export function snapshotsEndpoint(id: string): string {
  return `/api/scoring/snapshots/${id}`;
}

/** snapshot 履歴を取得する（GET snapshots）。!ok は throw。fetcher は DI 可能。 */
export async function fetchSnapshots(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<ScoreSnapshotRow[]> {
  const res = await fetcher(snapshotsEndpoint(id), { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`スコア履歴の取得に失敗しました（${res.status}）`);
  }
  const body = (await res.json()) as { data?: ScoreSnapshotRow[] };
  return body.data ?? [];
}

/** signalBonus / uncertaintyPenalty（Float?）の整形。未記録（null）は "—"。 */
function formatDelta(value: number | null): string {
  return value === null || value === undefined ? "—" : value.toFixed(1);
}

const COLUMNS: Column<ScoreSnapshotRow>[] = [
  { key: "snapshotAt", header: "日時", render: (r) => formatSnapshotAt(r.snapshotAt) },
  { key: "initialScore", header: "初期", render: (r) => formatScore(r.initialScore) },
  { key: "detailedScore", header: "詳細", render: (r) => formatScore(r.detailedScore) },
  { key: "signalBonus", header: "ボーナス", render: (r) => formatDelta(r.signalBonus) },
  {
    key: "uncertaintyPenalty",
    header: "ペナルティ",
    render: (r) => formatDelta(r.uncertaintyPenalty),
  },
  // confidence は別カラムで併置（§9.4/§9.5: スコアと別次元として可視化）。
  { key: "confidence", header: "確信度", render: (r) => formatConfidence(r.confidence) },
  { key: "configVersion", header: "config", render: (r) => r.configVersion ?? "—" },
  { key: "reason", header: "契機", render: (r) => r.reason ?? "—" },
];

export type ScoreHistoryViewProps = { snapshots: ScoreSnapshotRow[] };

/** スコア推移（表示専用）。新しい順の snapshot を表で並べる。 */
export function ScoreHistoryView({ snapshots }: ScoreHistoryViewProps) {
  return (
    <section aria-label="スコア履歴">
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>スコア履歴（{snapshots.length}）</h2>
      <Table
        columns={COLUMNS}
        rows={snapshots}
        getRowKey={(r) => r.id}
        empty="スコア履歴はありません（採点すると記録されます）"
      />
    </section>
  );
}

export type ScoreHistoryProps = {
  candidateId: string;
  /** 親が +1 する再取得シグナル（採点・merge/split 後に履歴を取り直す）。 */
  reloadSignal?: number;
};

/**
 * スコア履歴コンテナ。マウント時と reloadSignal 変化時に取得して反映する。
 * 取得は fetchSnapshots（純関数）に委譲し、最新レスポンスだけ採用する（stale 破棄）。
 */
export function ScoreHistory({ candidateId, reloadSignal }: ScoreHistoryProps) {
  const [snapshots, setSnapshots] = useState<ScoreSnapshotRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const guardRef = useRef(createLatestGuard());

  const load = useCallback(async () => {
    if (!candidateId) return;
    const token = guardRef.current.next();
    setError(null);
    try {
      const rows = await fetchSnapshots(candidateId);
      if (!guardRef.current.isCurrent(token)) return;
      setSnapshots(rows);
    } catch (e) {
      if (!guardRef.current.isCurrent(token)) return;
      setError(e instanceof Error ? e.message : "スコア履歴の取得に失敗しました");
      setSnapshots([]);
    }
  }, [candidateId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load, reloadSignal]);

  return (
    <>
      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13 }}>
          {error}
        </p>
      ) : null}
      <ScoreHistoryView snapshots={snapshots} />
    </>
  );
}
