import type { ReactNode } from "react";

import { Badge, type BadgeTone, Table, type Column } from "../ui";

// task-20 — Candidate 一覧テーブル（spec v2 §9.4）。
// カラム（§9.4）: displayId / title / targetUser / problemFamily / stage /
//   initialScore / detailedScore / confidence / distinctSources / nextAction。
//
// 設計意図（§9.4 / 冒頭注「pseudo-science 化の抑制」§9.5）:
//   スコア（initialScore / detailedScore）と confidence を別カラムで「併置」し、
//   評価を 1 つの数字に潰さない。confidence は色付きバッジで独立次元として強調し、
//   スコアの過信（複数シグナル一致の多重計上による見かけ上の高得点）を避ける。
//
// 表示専用（state を持たない）。バッジ色・数値整形・導線 href は純関数に切り出し、
// 依存追加なしの node テスト（renderToStaticMarkup）で直接検証できるようにする。

/**
 * 一覧 1 行のビュー表現。API（GET /api/candidates・/top100）の JSON をそのまま受ける形。
 * スコア（initialScore / detailedScore / confidence）は未採点だと null。
 */
export type CandidateRow = {
  id: string;
  displayId: string;
  title: string;
  targetUser: string | null;
  problemFamily: string | null;
  stage: string;
  initialScore: number | null;
  detailedScore: number | null;
  confidence: number | null;
  /**
   * Evidence の異なるソース種別数（§9.4 のカラム）。一覧 API が現状この派生値を
   * 返さない場合は null（"—" 表示）。提供されれば表示する。
   */
  distinctSources: number | null;
  nextAction: string | null;
};

// stage → バッジ色。未知値は neutral にフォールバック（壊さない）。
const STAGE_TONE: Record<string, BadgeTone> = {
  normalized: "neutral",
  top100: "info",
  top30: "info",
  hypothesis15: "info",
  smoke_test: "warning",
  mvp: "success",
  focus: "success",
  rejected: "danger",
  archived: "neutral",
};

export function stageTone(stage: string): BadgeTone {
  return STAGE_TONE[stage] ?? "neutral";
}

/**
 * confidence(0..1) → バッジ色。スコアと併置して「確信度」を独立次元として可視化する
 * （§9.4 冒頭注 / §9.5: スコアを 1 つの数字に潰さない）。null（未設定）は neutral。
 */
export function confidenceTone(confidence: number | null): BadgeTone {
  if (confidence === null) return "neutral";
  if (confidence >= 0.66) return "success";
  if (confidence >= 0.33) return "info";
  return "warning";
}

/** スコア（Float?）を一覧表示用に整形する。未採点（null/undefined）は "—"。 */
export function formatScore(value: number | null): string {
  return value === null || value === undefined ? "—" : value.toFixed(1);
}

/** confidence(0..1) を小数 2 桁で整形する。未設定は "—"。 */
export function formatConfidence(value: number | null): string {
  return value === null || value === undefined ? "—" : value.toFixed(2);
}

/** distinctSources（件数）。未提供（一覧 API 未対応）は "—"。 */
export function formatDistinctSources(value: number | null): string {
  return value === null || value === undefined ? "—" : String(value);
}

/** 長い nextAction は一覧では先頭のみ表示する（詳細は task-21 の編集画面で見る）。 */
export function truncate(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// 行からの導線。遷移先（詳細・スコア編集）は task-21 のスコープなので href だけ張る。
export function candidateDetailHref(id: string): string {
  return `/candidates/${id}`;
}

const COLUMNS: Column<CandidateRow>[] = [
  {
    key: "displayId",
    header: "ID",
    render: (r) => <a href={candidateDetailHref(r.id)}>{r.displayId}</a>,
  },
  { key: "title", header: "タイトル", render: (r) => r.title },
  { key: "targetUser", header: "対象ユーザー", render: (r) => r.targetUser ?? "—" },
  { key: "problemFamily", header: "課題ファミリ", render: (r) => r.problemFamily ?? "—" },
  {
    key: "stage",
    header: "stage",
    render: (r) => <Badge tone={stageTone(r.stage)}>{r.stage}</Badge>,
  },
  { key: "initialScore", header: "初期スコア", render: (r) => formatScore(r.initialScore) },
  { key: "detailedScore", header: "詳細スコア", render: (r) => formatScore(r.detailedScore) },
  {
    key: "confidence",
    header: "確信度",
    // スコアと別カラムで併置（§9.4 冒頭注: confidence を別次元として可視化）。
    render: (r) => <Badge tone={confidenceTone(r.confidence)}>{formatConfidence(r.confidence)}</Badge>,
  },
  {
    key: "distinctSources",
    header: "ソース種別数",
    render: (r) => formatDistinctSources(r.distinctSources),
  },
  {
    key: "nextAction",
    header: "次アクション",
    render: (r) => (r.nextAction ? truncate(r.nextAction) : "—"),
  },
];

export type CandidateTableProps = {
  rows: CandidateRow[];
  empty?: ReactNode;
};

export function CandidateTable({ rows, empty }: CandidateTableProps) {
  return (
    <Table
      columns={COLUMNS}
      rows={rows}
      getRowKey={(r) => r.id}
      empty={empty ?? "Candidate がありません"}
    />
  );
}
