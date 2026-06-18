"use client";

import { useCallback, useState } from "react";

import { type WatchlistItem } from "../../lib/api/watchlistClient";
import { Button, Input, Modal } from "../ui";

// task-37 — 今回値の記録ダイアログ（spec v2 §9.8 updateValue 導線）。
// 新しい currentValue を入力 → PATCH /api/watchlist/[id]。repository 側で
// lastValue←現 currentValue へシフトし deltaFlag を数値比較で再計算する。
// ここでは「いまの値」を文脈として見せ、新値の入力だけを受け取る（値シフトはサーバが行う）。

const FIELD_STYLE = { display: "flex", flexDirection: "column" as const, gap: 4, fontSize: 13 };
const CONTEXT_STYLE = {
  border: "1px solid #eaecf0",
  borderRadius: 8,
  padding: "8px 12px",
  marginBottom: 12,
  fontSize: 13,
  background: "#f9fafb",
} as const;

/** 値の表示（null / 空は "（未記録）"）。 */
function showValue(value: string | null): string {
  return value && value.trim() !== "" ? value : "（未記録）";
}

export type UpdateValueDialogProps = {
  /** 対象 Watchlist（null なら閉じている）。 */
  item: WatchlistItem | null;
  onClose: () => void;
  /** 新値を送信。成功/失敗は親が握る。 */
  onSubmit: (item: WatchlistItem, value: string) => Promise<void>;
};

/** 今回値の入力ダイアログ。item が変わるたびフレッシュマウントされる前提（親が key/条件描画）。 */
export function UpdateValueDialog({ item, onClose, onSubmit }: UpdateValueDialogProps) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(() => {
    if (item === null || value.trim() === "" || submitting) return;
    setSubmitting(true);
    setError(null);
    void (async () => {
      try {
        await onSubmit(item, value.trim());
      } catch (e) {
        setError(e instanceof Error ? e.message : "今回値の記録に失敗しました");
      } finally {
        setSubmitting(false);
      }
    })();
  }, [item, value, submitting, onSubmit]);

  if (item === null) return null;
  const canSubmit = value.trim() !== "" && !submitting;

  return (
    <Modal open onClose={onClose} title="今回値を記録">
      <div style={CONTEXT_STYLE}>
        <div>
          <strong>{item.entityName}</strong>
          {item.metricName ? <span style={{ color: "#667085" }}> / {item.metricName}</span> : null}
        </div>
        <div style={{ marginTop: 4, color: "#667085" }}>
          いまの値: <strong>{showValue(item.currentValue)}</strong>
          <span style={{ marginLeft: 8 }}>
            （記録すると前回値へ移り、差分が再計算されます）
          </span>
        </div>
      </div>

      <label style={FIELD_STYLE}>
        <span style={{ fontWeight: 600 }}>今回値</span>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="1 / ¥500 / 3.5 など"
          aria-label="今回値"
        />
      </label>

      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13, marginTop: 12 }}>
          {error}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          キャンセル
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
          {submitting ? "記録中…" : "記録する"}
        </Button>
      </div>
    </Modal>
  );
}
