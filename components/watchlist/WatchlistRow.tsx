import { Badge, Button } from "../ui";
import {
  deltaPresentation,
  type WatchlistCandidateOption,
  type WatchlistItem,
} from "../../lib/api/watchlistClient";

// task-37 — Watchlist 一覧の 1 行（spec v2 §9.8）。
// 1 行 = 1 ウォッチ対象。metricName / lastValue → currentValue / deltaFlag（アイコン＋色＋テキスト）/
// lastCheckedAt / 紐付け候補 を表示し、「今回値を記録」「編集」「削除」の操作を配る。
// 状態は持たない表示専用コンポーネント（操作はコールバックで親へ委譲）。

/** entityType コード → 表示ラベル（§9.8 の値域）。未知コードはそのまま表示する。 */
export const ENTITY_TYPE_LABELS: Record<string, string> = {
  competitor_app: "競合アプリ",
  keyword: "キーワード",
  ranking: "ランキング",
  template_sale: "テンプレ販売",
  outsource_category: "外注カテゴリ",
  regulation_page: "法改正ページ",
  plugin: "プラグイン",
};

/** 値の表示（null / 空は "—"）。 */
function showValue(value: string | null): string {
  return value && value.trim() !== "" ? value : "—";
}

/** lastCheckedAt（ISO 文字列）を日付部分だけにして表示する。未記録は "—"。 */
export function formatCheckedAt(iso: string | null): string {
  if (!iso) return "—";
  // ISO の日付部分（YYYY-MM-DD）。タイムゾーン差で表示がぶれないよう前 10 文字を使う。
  return iso.slice(0, 10);
}

/** deltaFlag のバッジ。アイコン＋ラベルを併記し色だけに依存しない（a11y）。 */
export function DeltaBadge({ flag }: { flag: string }) {
  const { icon, label, tone, muted } = deltaPresentation(flag);
  return (
    <Badge tone={tone} className={muted ? "mi-badge--muted" : undefined}>
      <span aria-hidden="true">{icon}</span> {label}
    </Badge>
  );
}

const CANDIDATE_LINK_STYLE = { color: "#155eef", fontSize: 13 } as const;
const ACTION_CELL_STYLE = { display: "flex", gap: 6, flexWrap: "wrap" as const } as const;

export type WatchlistRowProps = {
  item: WatchlistItem;
  /** 紐付け候補の表示用（id→displayId/title）。無ければ id をそのまま出す。 */
  candidate?: WatchlistCandidateOption;
  onRecordValue: (item: WatchlistItem) => void;
  onEdit: (item: WatchlistItem) => void;
  onDelete: (item: WatchlistItem) => void;
  /** 処理中（その行のボタンを無効化して多重送信を防ぐ）。 */
  pending?: boolean;
};

/** Watchlist 一覧の 1 行（<tr>）。 */
export function WatchlistRow({
  item,
  candidate,
  onRecordValue,
  onEdit,
  onDelete,
  pending,
}: WatchlistRowProps) {
  return (
    <tr>
      <td>
        <div style={{ fontWeight: 600 }}>{item.entityName}</div>
        <div style={{ color: "#667085", fontSize: 12 }}>
          {ENTITY_TYPE_LABELS[item.entityType] ?? item.entityType}
        </div>
      </td>
      <td>{showValue(item.metricName)}</td>
      <td>
        <span style={{ color: "#667085" }}>{showValue(item.lastValue)}</span>
        <span aria-hidden="true" style={{ margin: "0 6px", color: "#98a2b3" }}>
          →
        </span>
        <strong>{showValue(item.currentValue)}</strong>
      </td>
      <td>
        <DeltaBadge flag={item.deltaFlag} />
      </td>
      <td>{formatCheckedAt(item.lastCheckedAt)}</td>
      <td>
        {item.linkedCandidateId ? (
          <a href={`/candidates/${item.linkedCandidateId}`} style={CANDIDATE_LINK_STYLE}>
            {candidate ? `${candidate.displayId} ${candidate.title}` : item.linkedCandidateId}
          </a>
        ) : (
          <span style={{ color: "#98a2b3" }}>—</span>
        )}
      </td>
      <td>
        <div style={ACTION_CELL_STYLE}>
          <Button variant="primary" onClick={() => onRecordValue(item)} disabled={pending}>
            今回値を記録
          </Button>
          <Button variant="ghost" onClick={() => onEdit(item)} disabled={pending}>
            編集
          </Button>
          <Button variant="danger" onClick={() => onDelete(item)} disabled={pending}>
            削除
          </Button>
        </div>
      </td>
    </tr>
  );
}
