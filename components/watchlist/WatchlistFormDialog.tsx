"use client";

import { useCallback, useState } from "react";

import { WATCHLIST_ENTITY_TYPE_VALUES } from "../../lib/validation/enums";
import {
  emptyWatchlistForm,
  type WatchlistCandidateOption,
  type WatchlistFormValues,
} from "../../lib/api/watchlistClient";
import { Button, Input, Modal, Select, type SelectOption } from "../ui";
import { ENTITY_TYPE_LABELS } from "./WatchlistRow";

// task-37 — Watchlist 新規作成 / 編集ダイアログ（spec v2 §9.8）。
// entityType / entityName / metricName / locale / linkedCandidateId / note を編集する。
// linkedCandidateId は候補一覧から選択 or 空（任意）。値（lastValue/currentValue）は
// この画面では扱わず「今回値を記録」（UpdateValueDialog）で更新する（§9.8 の値シフトを一本化）。
//
// 送信ボディの組立（空フィールドの省略・空文字 linkedCandidateId を積まない）は client の
// toWriteBody が担う。ここでは入力状態の保持と onSubmit への受け渡しだけを行う。

/** entityType の選択肢。enum 値タプル（task-02）から生成する（文字列直書きしない）。 */
export const ENTITY_TYPE_OPTIONS: SelectOption[] = WATCHLIST_ENTITY_TYPE_VALUES.map((value) => ({
  value,
  label: ENTITY_TYPE_LABELS[value] ?? value,
}));

const FIELD_STYLE = { display: "flex", flexDirection: "column" as const, gap: 4, fontSize: 13 };
const LABEL_STYLE = { fontWeight: 600 } as const;
const GRID_STYLE = { display: "grid", gap: 12 } as const;

export type WatchlistFormDialogProps = {
  open: boolean;
  /** 編集対象の初期値。新規作成なら undefined。 */
  initial?: WatchlistFormValues;
  /** 紐付け候補の選択肢（空可）。 */
  candidates: WatchlistCandidateOption[];
  onClose: () => void;
  /** 送信。成功/失敗は親が握る（ここは送信中フラグだけ持つ）。 */
  onSubmit: (values: WatchlistFormValues) => Promise<void>;
};

/** 新規作成 / 編集を兼ねるフォームダイアログ。開くたびにフレッシュマウントされる前提。 */
export function WatchlistFormDialog({
  open,
  initial,
  candidates,
  onClose,
  onSubmit,
}: WatchlistFormDialogProps) {
  const isEdit = initial !== undefined;
  const [values, setValues] = useState<WatchlistFormValues>(initial ?? emptyWatchlistForm());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof WatchlistFormValues>(key: K, v: WatchlistFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  // entityName 必須。それ以外は任意（client 側で空は省略される）。
  const canSubmit = values.entityName.trim() !== "" && !submitting;

  const handleSubmit = useCallback(() => {
    if (values.entityName.trim() === "" || submitting) return;
    setSubmitting(true);
    setError(null);
    void (async () => {
      try {
        await onSubmit(values);
      } catch (e) {
        setError(e instanceof Error ? e.message : "保存に失敗しました");
      } finally {
        setSubmitting(false);
      }
    })();
  }, [values, submitting, onSubmit]);

  const candidateOptions: SelectOption[] = [
    { value: "", label: "（紐付けなし）" },
    ...candidates.map((c) => ({ value: c.id, label: `${c.displayId} ${c.title}` })),
  ];

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? "Watchlist を編集" : "Watchlist を追加"}>
      <div style={GRID_STYLE}>
        <label style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>種別</span>
          <Select
            options={ENTITY_TYPE_OPTIONS}
            value={values.entityType}
            onChange={(e) => set("entityType", e.target.value)}
            aria-label="種別"
          />
        </label>

        <label style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>対象名</span>
          <Input
            value={values.entityName}
            onChange={(e) => set("entityName", e.target.value)}
            placeholder="Acme 請求書アプリ"
            aria-label="対象名"
          />
        </label>

        <label style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>指標</span>
          <Input
            value={values.metricName}
            onChange={(e) => set("metricName", e.target.value)}
            placeholder="ランキング / 価格 / レビュー数 …"
            aria-label="指標"
          />
        </label>

        <label style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>ロケール</span>
          <Input
            value={values.locale}
            onChange={(e) => set("locale", e.target.value)}
            placeholder="ja-JP（任意）"
            aria-label="ロケール"
          />
        </label>

        <label style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>紐付け候補</span>
          <Select
            options={candidateOptions}
            value={values.linkedCandidateId}
            onChange={(e) => set("linkedCandidateId", e.target.value)}
            aria-label="紐付け候補"
          />
        </label>

        <label style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>メモ</span>
          <Input
            value={values.note}
            onChange={(e) => set("note", e.target.value)}
            placeholder="観測の文脈・注意点（任意）"
            aria-label="メモ"
          />
        </label>
      </div>

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
          {submitting ? "保存中…" : isEdit ? "更新する" : "追加する"}
        </Button>
      </div>
    </Modal>
  );
}
