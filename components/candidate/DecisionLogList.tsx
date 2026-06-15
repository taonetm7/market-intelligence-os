"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Badge, type BadgeTone } from "../ui";
import { createLatestGuard } from "./CandidateDetail";
import { type DecisionType } from "../../lib/validation/enums";

// task-31 — DecisionLog 一覧（spec v2 §7.6 / §15.2 / §15.3）。
// 候補に刻まれた判断ログ（promote / demote / reject / merge / split / hold）を新しい順で表示し、
// 「なぜその判断をしたか」を詳細画面で追えるようにする（§15.3）。取得は GET
// /api/candidates/[id]/decision-logs（task-31 案A で追加）を薄く叩くだけで、ロジックは持たない。
//
// 設計（既存 UI の流儀）: 取得は純関数（fetcher DI）に切り出し、表示は state を持たないビューに分け
// renderToStaticMarkup で検証する。state（取得・再取得）はコンテナが持つ。
// decisionType ラベル/色は enum（DecisionType）をキーにした Record で持ち、文字列直書きを避ける
// （enum 追加時に網羅漏れがコンパイルで顕在化する）。

/**
 * DecisionLog 1 行の表示形（GET /api/candidates/[id]/decision-logs の data 要素）。
 * Response.json が Date を ISO 文字列へ直列化するため decidedAt は string。
 */
export type DecisionLogRow = {
  id: string;
  decisionType: string;
  fromStage: string | null;
  toStage: string | null;
  relatedCandidateId: string | null;
  reason: string;
  decidedAt: string;
};

/** decisionType（enum）→ 表示ラベル。enum を正とし、未知値は値そのものを出す。 */
const DECISION_TYPE_LABELS: Record<DecisionType, string> = {
  promote: "昇格",
  demote: "降格",
  reject: "棄却",
  merge: "統合",
  split: "分割",
  hold: "保留",
};

/** decisionType（enum）→ バッジ色。未知値は neutral にフォールバック（壊さない）。 */
const DECISION_TYPE_TONE: Record<DecisionType, BadgeTone> = {
  promote: "success",
  demote: "warning",
  reject: "danger",
  merge: "info",
  split: "info",
  hold: "neutral",
};

export function decisionTypeLabel(type: string): string {
  return DECISION_TYPE_LABELS[type as DecisionType] ?? type;
}
export function decisionTypeTone(type: string): BadgeTone {
  return DECISION_TYPE_TONE[type as DecisionType] ?? "neutral";
}

/**
 * ISO 文字列を「YYYY-MM-DD HH:mm」へ整形する（UTC のまま・locale 非依存で決定的）。
 * 解析できない値はそのまま返す（防御）。テストの決定論のため Date 経由の locale 整形は避ける。
 */
export function formatDecidedAt(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return m ? `${m[1]} ${m[2]}` : value;
}

/** stage 遷移を「from → to」へ整形する（片側のみ・両方無しにも耐える）。 */
export function formatStageTransition(from: string | null, to: string | null): string {
  if (from && to) return `${from} → ${to}`;
  if (to) return `→ ${to}`;
  if (from) return `${from} →`;
  return "";
}

/** DecisionLog の endpoint（task-31 案A で追加した GET）。 */
export function decisionLogsEndpoint(id: string): string {
  return `/api/candidates/${id}/decision-logs`;
}

/** 判断ログを取得する（GET decision-logs）。!ok は throw。fetcher は DI 可能。 */
export async function fetchDecisionLogs(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<DecisionLogRow[]> {
  const res = await fetcher(decisionLogsEndpoint(id), { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`判断ログの取得に失敗しました（${res.status}）`);
  }
  const body = (await res.json()) as { data?: DecisionLogRow[] };
  return body.data ?? [];
}

const LIST_STYLE = { listStyle: "none", margin: 0, padding: 0 } as const;
const ITEM_STYLE = {
  padding: "8px 0",
  borderBottom: "1px solid #eaecf0",
  fontSize: 13,
} as const;
const META_STYLE = { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" } as const;
const TIME_STYLE = { color: "#667085" } as const;

export type DecisionLogListViewProps = { logs: DecisionLogRow[] };

/**
 * 判断ログ一覧（表示専用）。種別バッジ・stage 遷移・日時・理由を新しい順で並べる。
 * 理由（§15.3 必須）を本文として強調し、「なぜその判断をしたか」を追えるようにする。
 */
export function DecisionLogListView({ logs }: DecisionLogListViewProps) {
  return (
    <section aria-label="判断ログ一覧">
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>判断ログ（{logs.length}）</h2>
      {logs.length === 0 ? (
        <p style={{ color: "#667085", fontSize: 13 }}>
          判断ログはありません（promote / reject / merge / split で記録されます）。
        </p>
      ) : (
        <ul style={LIST_STYLE}>
          {logs.map((log) => {
            const transition = formatStageTransition(log.fromStage, log.toStage);
            return (
              <li key={log.id} style={ITEM_STYLE}>
                <div style={META_STYLE}>
                  <Badge tone={decisionTypeTone(log.decisionType)}>
                    {decisionTypeLabel(log.decisionType)}
                  </Badge>
                  {transition ? <span>{transition}</span> : null}
                  <span style={TIME_STYLE}>{formatDecidedAt(log.decidedAt)}</span>
                  {log.relatedCandidateId ? (
                    <span style={TIME_STYLE}>相手候補: {log.relatedCandidateId}</span>
                  ) : null}
                </div>
                <div style={{ marginTop: 4 }}>{log.reason}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export type DecisionLogListProps = {
  candidateId: string;
  /** 親が +1 する再取得シグナル（promote / merge / split 後に履歴を取り直す）。 */
  reloadSignal?: number;
};

/**
 * 判断ログ一覧コンテナ。マウント時と reloadSignal 変化時に取得して反映する。
 * 取得は fetchDecisionLogs（純関数）に委譲し、最新レスポンスだけ採用する（stale 破棄）。
 */
export function DecisionLogList({ candidateId, reloadSignal }: DecisionLogListProps) {
  const [logs, setLogs] = useState<DecisionLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const guardRef = useRef(createLatestGuard());

  const load = useCallback(async () => {
    if (!candidateId) return;
    const token = guardRef.current.next();
    setError(null);
    try {
      const rows = await fetchDecisionLogs(candidateId);
      if (!guardRef.current.isCurrent(token)) return;
      setLogs(rows);
    } catch (e) {
      if (!guardRef.current.isCurrent(token)) return;
      setError(e instanceof Error ? e.message : "判断ログの取得に失敗しました");
      setLogs([]);
    }
  }, [candidateId]);

  // 初回マウントと reloadSignal 変化で取得する。setState を effect 本体から外へ出すため
  // タイマ経由で実行する（cascading render 警告を避ける。task-19/20/21 と同じ流儀）。
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
      <DecisionLogListView logs={logs} />
    </>
  );
}
