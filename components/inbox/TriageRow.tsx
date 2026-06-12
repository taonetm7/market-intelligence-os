import { Badge, Button } from "../ui";

// task-18 — Inbox Triage の 1 行（spec v2 §9.1 既定ランディング）。
// 未紐付け Raw Signal を上から捌くための 1 行表示。観測事実・sourceType・URL を見せ、
// 操作ボタン（Link / 新規候補化 / Ignore / Archive）を並べる。
//
// 表示専用（state を持たない）。値整形は純関数に切り出し、依存追加なしの node テスト
// （renderToStaticMarkup）で直接検証できるようにする。各操作は親から渡されるコールバックを
// 呼ぶだけ（API 呼び出し・キュー再取得の責務は page / TriageQueue 側）。

/**
 * トリアージ 1 件のビュー表現。GET /api/raw-signals?unlinked=1 の JSON をそのまま受ける形
 * （未処理＝status inbox かつ Evidence 0 件のみがサーバ側で返る）。表示に使う最小フィールド。
 */
export type TriageSignal = {
  id: string;
  displayId: string;
  sourceType: string;
  sourceUrl: string | null;
  rawText: string;
  observedEntity: string | null;
  status: string;
};

/** 長い観測本文はキューでは先頭のみ表示する（全文は詳細・編集画面で見る）。 */
export function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 観測対象は未設定なら "—"。 */
export function formatObservedEntity(value: string | null): string {
  return value && value.trim() !== "" ? value : "—";
}

const CELL_STYLE = { padding: "12px 0", borderBottom: "1px solid #eaecf0" } as const;
const META_STYLE = { display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#667085" } as const;
const ACTIONS_STYLE = { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 } as const;

export type TriageRowProps = {
  signal: TriageSignal;
  /** Link UI（task-22）起動の導線。本タスクでは起動フックのみ（サジェスト本体は task-22）。 */
  onLink: (signal: TriageSignal) => void;
  /** 新規候補化（Candidate 作成 → 即 link）。 */
  onPromote: (signal: TriageSignal) => void;
  onIgnore: (signal: TriageSignal) => void;
  onArchive: (signal: TriageSignal) => void;
  /** この行が処理中（多重送信を防ぐためボタンを無効化）。 */
  pending?: boolean;
};

/** トリアージ 1 行。観測事実＋メタ＋操作ボタン。操作は親コールバックへ委譲する。 */
export function TriageRow({
  signal,
  onLink,
  onPromote,
  onIgnore,
  onArchive,
  pending = false,
}: TriageRowProps) {
  return (
    <li style={CELL_STYLE} aria-label={`triage ${signal.displayId}`}>
      <div style={META_STYLE}>
        <span>{signal.displayId}</span>
        <Badge tone="info">{signal.sourceType}</Badge>
        {signal.sourceUrl ? (
          <a href={signal.sourceUrl} target="_blank" rel="noreferrer noopener">
            URL
          </a>
        ) : (
          <span>URL —</span>
        )}
        <span>対象: {formatObservedEntity(signal.observedEntity)}</span>
      </div>

      <p style={{ margin: "6px 0 0", fontSize: 14, lineHeight: 1.5 }}>{truncate(signal.rawText)}</p>

      <div style={ACTIONS_STYLE}>
        <Button variant="primary" onClick={() => onLink(signal)} disabled={pending}>
          Link
        </Button>
        <Button variant="secondary" onClick={() => onPromote(signal)} disabled={pending}>
          新規候補化
        </Button>
        <Button variant="ghost" onClick={() => onIgnore(signal)} disabled={pending}>
          Ignore
        </Button>
        <Button variant="ghost" onClick={() => onArchive(signal)} disabled={pending}>
          Archive
        </Button>
      </div>
    </li>
  );
}
