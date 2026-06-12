import type { ReactNode } from "react";

import { Badge, type BadgeTone, Table, type Column } from "../ui";

// task-19 — Raw Signal 一覧テーブル（spec v2 §9.3）。
// 全 Raw Signal の閲覧・再編集・link 入口。カラムは §9.3 の定義に従う:
//   displayId / 追加日 / sourceType / sourceName / 観測事実 / タグ /
//   紐付け候補数 / origin / status / 操作（編集・link 導線）
//
// 表示専用（state を持たない）。バッジ色・日付整形・導線 href は純関数に切り出し、
// 依存追加なしの node テスト（renderToStaticMarkup）で直接検証できるようにする。

/**
 * 一覧 1 行のビュー表現。API（GET /api/raw-signals）の JSON をそのまま受ける形。
 * addedAt は JSON 化で ISO 文字列、signalTags は配列、evidenceCount は件数。
 */
export type RawSignalRow = {
  id: string;
  displayId: string;
  addedAt: string;
  sourceType: string;
  sourceName: string | null;
  rawText: string;
  observedEntity: string | null;
  signalTags: string[];
  evidenceCount: number;
  origin: string;
  status: string;
};

// status / origin → バッジ色。未知値は neutral にフォールバック（壊さない）。
const STATUS_TONE: Record<string, BadgeTone> = {
  inbox: "info",
  ignored: "warning",
  archived: "neutral",
};
const ORIGIN_TONE: Record<string, BadgeTone> = {
  manual: "neutral",
  import: "info",
  ai: "success",
};

export function statusTone(status: string): BadgeTone {
  return STATUS_TONE[status] ?? "neutral";
}

export function originTone(origin: string): BadgeTone {
  return ORIGIN_TONE[origin] ?? "neutral";
}

/** ISO 文字列を YYYY-MM-DD で表示する（ロケール非依存・決定的）。 */
export function formatAddedAt(iso: string): string {
  return typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : String(iso ?? "");
}

/** 長い観測本文は一覧では先頭のみ表示する（詳細は編集画面で見る）。 */
export function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// 行からの導線。遷移先画面自体は task-21/22 のスコープなのでここでは作らず href だけ張る。
export function rawSignalDetailHref(id: string): string {
  return `/raw-signals/${id}`;
}
export function rawSignalLinkHref(id: string): string {
  return `/raw-signals/${id}/link`;
}

const COLUMNS: Column<RawSignalRow>[] = [
  {
    key: "displayId",
    header: "ID",
    render: (r) => <a href={rawSignalDetailHref(r.id)}>{r.displayId}</a>,
  },
  { key: "addedAt", header: "追加日", render: (r) => formatAddedAt(r.addedAt) },
  { key: "sourceType", header: "ソース種別" },
  { key: "sourceName", header: "ソース名", render: (r) => r.sourceName ?? "—" },
  { key: "rawText", header: "観測事実", render: (r) => truncate(r.rawText) },
  {
    key: "signalTags",
    header: "タグ",
    render: (r) => (r.signalTags.length > 0 ? r.signalTags.join(", ") : "—"),
  },
  { key: "evidenceCount", header: "紐付け候補数", render: (r) => r.evidenceCount },
  {
    key: "origin",
    header: "origin",
    render: (r) => <Badge tone={originTone(r.origin)}>{r.origin}</Badge>,
  },
  {
    key: "status",
    header: "status",
    render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge>,
  },
  {
    key: "actions",
    header: "操作",
    render: (r) => (
      <span style={{ whiteSpace: "nowrap" }}>
        <a href={rawSignalDetailHref(r.id)}>編集</a>
        {" / "}
        <a href={rawSignalLinkHref(r.id)}>link</a>
      </span>
    ),
  },
];

export type RawSignalTableProps = {
  rows: RawSignalRow[];
  empty?: ReactNode;
};

export function RawSignalTable({ rows, empty }: RawSignalTableProps) {
  return (
    <Table
      columns={COLUMNS}
      rows={rows}
      getRowKey={(r) => r.id}
      empty={empty ?? "Raw Signal がありません"}
    />
  );
}
