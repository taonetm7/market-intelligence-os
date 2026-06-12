"use client";

import { useState } from "react";

import { Button, Input, Select, type SelectOption } from "../ui";
import { SOURCE_TYPE_VALUES } from "../../lib/validation/enums";
import { rawSignalInputSchema, type RawSignalInput } from "../../lib/validation/schemas";

// task-17 — Raw Signal Quick Capture（spec v2 §9.2 最重要 UX）。
// 最上流の収集速度がファネル品質を決めるため、既定表示は 4 項目だけに絞る:
//   sourceType / url(=sourceUrl) / rawText / observedEntity
// 残り（country / price 等）は「詳細を追加」で折りたたみ（既定は閉じる）。
// 保存後はフォームを保持し連続入力できる UX（クリアして次へ）。
//
// 描画はクライアントだが、ロジック（検証・ペイロード組立・送信）は純関数として
// 切り出し、依存追加なしの node テスト（renderToStaticMarkup 環境）で直接駆動できる
// ようにしている。検証は task-02 の rawSignalInputSchema 経由（enum 直書きしない）。

/** Quick Capture が保持する素の入力値（すべて文字列。空文字 = 未入力）。 */
export type QuickCaptureFields = {
  // 既定表示の 4 項目
  sourceType: string;
  url: string;
  rawText: string;
  observedEntity: string;
  // 「詳細を追加」（折りたたみ・任意）
  country: string;
  observedPrice: string;
  note: string;
};

/** 必須項目のインラインエラー（フィールド単位）。 */
export type QuickCaptureErrors = Partial<Record<"sourceType" | "rawText", string>>;

/** クリア済み（空）の入力値。初期表示と保存後の継続入力で使う。 */
export function emptyQuickCaptureFields(): QuickCaptureFields {
  return {
    sourceType: "",
    url: "",
    rawText: "",
    observedEntity: "",
    country: "",
    observedPrice: "",
    note: "",
  };
}

/** sourceType セレクトの選択肢（enum は task-02 の値タプルから生成）。 */
export const SOURCE_TYPE_OPTIONS: SelectOption[] = SOURCE_TYPE_VALUES.map((v) => ({
  value: v,
  label: v,
}));

/**
 * 入力値から POST ペイロードを組み立てる。
 * 必須 2 項目（sourceType / rawText）は常に含め、任意項目は非空のときだけ含める。
 * trim 済みの値を渡し、空文字の任意項目はキー自体を落とす。
 */
export function buildRawSignalInput(fields: QuickCaptureFields): Record<string, unknown> {
  const input: Record<string, unknown> = {
    sourceType: fields.sourceType,
    rawText: fields.rawText.trim(),
  };
  const url = fields.url.trim();
  if (url) input.sourceUrl = url;
  const entity = fields.observedEntity.trim();
  if (entity) input.observedEntity = entity;
  const country = fields.country.trim();
  if (country) input.country = country;
  const price = fields.observedPrice.trim();
  if (price) input.observedPrice = price;
  const note = fields.note.trim();
  if (note) input.note = note;
  return input;
}

/**
 * task-02 の Zod スキーマで検証する。成功なら repository に渡せる入力を、
 * 失敗なら必須項目（sourceType / rawText）のインラインエラーを返す。
 */
export function validateQuickCapture(
  fields: QuickCaptureFields,
):
  | { ok: true; input: RawSignalInput; errors: QuickCaptureErrors }
  | { ok: false; errors: QuickCaptureErrors } {
  const result = rawSignalInputSchema.safeParse(buildRawSignalInput(fields));
  if (result.success) {
    return { ok: true, input: result.data, errors: {} };
  }
  const errors: QuickCaptureErrors = {};
  for (const issue of result.error.issues) {
    const path = issue.path[0];
    if (path === "sourceType") {
      errors.sourceType = "ソース種別を選択してください";
    } else if (path === "rawText") {
      errors.rawText = "本文（rawText）は必須です";
    }
  }
  return { ok: false, errors };
}

/** 送信結果。失敗時はインラインエラーで理由を返す。 */
export type SubmitResult =
  | { ok: true; data: unknown }
  | { ok: false; errors: QuickCaptureErrors };

/**
 * 検証 → POST /api/raw-signals（task-11）。fetcher は DI 可能（テストで差し替える）。
 * 検証 NG なら API を呼ばずインラインエラーを返す（必須未入力で送信不可）。
 */
export async function submitRawSignal(
  fields: QuickCaptureFields,
  fetcher: typeof fetch = fetch,
): Promise<SubmitResult> {
  const validated = validateQuickCapture(fields);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors };
  }
  // ネットワーク層は throw（接続失敗・タイムアウト等）し得るため catch し、
  // 入力を保持したまま再試行できるインラインエラーへ変換する（指摘2）。
  let res: Response;
  try {
    res = await fetcher("/api/raw-signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validated.input),
    });
  } catch {
    return {
      ok: false,
      errors: { rawText: "通信に失敗しました。接続を確認して再試行してください" },
    };
  }
  if (!res.ok) {
    return { ok: false, errors: { rawText: "保存に失敗しました。時間をおいて再試行してください" } };
  }
  const body = (await res.json()) as { data?: unknown };
  return { ok: true, data: body.data };
}

const ERROR_STYLE = { color: "#b42318", fontSize: 12, marginTop: 4 } as const;
const FIELD_STYLE = { display: "block", marginBottom: 12 } as const;
const LABEL_STYLE = { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 } as const;

export type QuickCaptureProps = {
  /** 保存後に呼ばれる（一覧再取得など）。任意。 */
  onSaved?: (data: unknown) => void;
};

/**
 * Quick Capture フォーム本体。キーボードのみで完結（Tab→Enter 送信）。
 * 保存に成功すると 4 項目をクリアして連続入力できる（フォームは保持）。
 */
export function QuickCapture({ onSaved }: QuickCaptureProps) {
  const [fields, setFields] = useState<QuickCaptureFields>(emptyQuickCaptureFields);
  const [errors, setErrors] = useState<QuickCaptureErrors>({});
  const [showDetails, setShowDetails] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof QuickCaptureFields>(key: K, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  function handleRawTextKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // textarea では Enter=改行（本文に改行を入れられるようにする）。
    // 送信は Cmd/Ctrl+Enter（＋保存ボタン）でキーボード完結を維持する。
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // 送信前の即時検証（必須未入力なら API を呼ばずインラインエラー）。
    const validated = validateQuickCapture(fields);
    if (!validated.ok) {
      setErrors(validated.errors);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const result = await submitRawSignal(fields);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      // 連続入力 UX: クリアしてフォームを保持し、すぐ次を入力できる。
      setFields(emptyQuickCaptureFields());
      setShowDetails(false);
      setSavedCount((n) => n + 1);
      onSaved?.(result.data);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-label="Raw Signal Quick Capture">
      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>ソース種別（必須）</span>
        <Select
          options={SOURCE_TYPE_OPTIONS}
          placeholder="選択してください"
          value={fields.sourceType}
          onChange={(e) => update("sourceType", e.target.value)}
          aria-invalid={errors.sourceType ? true : undefined}
        />
        {errors.sourceType ? (
          <span role="alert" style={ERROR_STYLE}>
            {errors.sourceType}
          </span>
        ) : null}
      </label>

      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>本文 / 観測内容（必須）</span>
        <textarea
          className="mi-input"
          rows={3}
          value={fields.rawText}
          onChange={(e) => update("rawText", e.target.value)}
          onKeyDown={handleRawTextKeyDown}
          placeholder="観測した事実を記入（改行可。Cmd/Ctrl+Enter で保存）"
          aria-invalid={errors.rawText ? true : undefined}
          style={{ resize: "vertical", fontFamily: "inherit" }}
        />
        {errors.rawText ? (
          <span role="alert" style={ERROR_STYLE}>
            {errors.rawText}
          </span>
        ) : null}
      </label>

      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>URL</span>
        <Input
          type="url"
          value={fields.url}
          onChange={(e) => update("url", e.target.value)}
          placeholder="https://…（任意）"
        />
      </label>

      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>観測対象（アプリ/企業など）</span>
        <Input
          value={fields.observedEntity}
          onChange={(e) => update("observedEntity", e.target.value)}
          placeholder="任意"
        />
      </label>

      <Button variant="ghost" onClick={() => setShowDetails((v) => !v)} aria-expanded={showDetails}>
        {showDetails ? "詳細を閉じる" : "詳細を追加"}
      </Button>

      {showDetails ? (
        <div style={{ marginTop: 12 }}>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>国</span>
            <Input
              value={fields.country}
              onChange={(e) => update("country", e.target.value)}
              placeholder="任意"
            />
          </label>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>価格</span>
            <Input
              value={fields.observedPrice}
              onChange={(e) => update("observedPrice", e.target.value)}
              placeholder="任意"
            />
          </label>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>メモ</span>
            <Input
              value={fields.note}
              onChange={(e) => update("note", e.target.value)}
              placeholder="任意"
            />
          </label>
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? "保存中…" : "保存して次へ"}
        </Button>
        {savedCount > 0 ? (
          <span role="status" style={{ fontSize: 13, color: "#1a7f3c" }}>
            保存しました（このセッションで {savedCount} 件）
          </span>
        ) : null}
      </div>
    </form>
  );
}
