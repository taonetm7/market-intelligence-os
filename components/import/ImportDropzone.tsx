"use client";

import { useCallback, useState } from "react";

import { Button, Select, type SelectOption } from "../ui";

// task-23 — Import 投入（貼付 / ファイル → POST import）。spec v2 §10.1 / §11.2。
// JSON / CSV を貼り付け or アップロードし、POST /api/raw-signals/import（task-15）で quarantine
// （隔離テーブル）へ投入する。即本登録はしない（§10.1 step4：AI・外部データを DB に直接入れない
// 関門）。本登録は QuarantineReview の accept で人間が承認したときだけ行う。
//
// origin は §10.1 に従い batch 単位で既定 import 固定（UI では出さない）。AI 経由 import の
// 専用 UI は Slice 5（task doc Out of scope）。
//
// テスト基盤に DOM / インタラクション依存は足さない方針のため、送信ロジックは純関数
// （fetcher DI）として切り出し、描画は react-dom/server の静的描画で確認する。

/** import 投入 API（task-15）。 */
export const IMPORT_URL = "/api/raw-signals/import";

// 受領フォーマット（json | csv）。server 側 BATCH_FORMAT_VALUES（lib/import/quarantineRepo）と
// 同値だが、あのモジュールは Prisma を取り込むため client バンドルへ入れられない。UI 専用に
// ローカル定義する（値が増えたら両所を揃える）。
export const IMPORT_FORMAT_VALUES = ["json", "csv"] as const;
export type ImportFormat = (typeof IMPORT_FORMAT_VALUES)[number];

/** フォーマット選択肢。固定ヘッダ CSV / §10.1 エンベロープ JSON。 */
export const IMPORT_FORMAT_OPTIONS: SelectOption[] = [
  { value: "json", label: "JSON（{ rawSignals: [...] }）" },
  { value: "csv", label: "CSV（固定ヘッダ）" },
];

/** import 成功時の要約（POST import の data を行数に畳んだもの）。 */
export type ImportSummary = {
  batchId: string;
  format: string;
  pendingCount: number;
  invalidCount: number;
};

/** content が空（空白のみ）かどうか。空送信を UI で弾く純関数。 */
export function isBlankContent(content: string): boolean {
  return content.trim() === "";
}

/** API 共通形 { data } を取り出す。!ok は失敗で throw（呼び出し側が握る）。 */
async function readData<T>(res: Response, failMessage: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${failMessage}（${res.status}）`);
  }
  const body = (await res.json()) as { data?: T };
  if (!body.data) {
    throw new Error(`${failMessage}（応答が不正です）`);
  }
  return body.data;
}

/**
 * import を POST する（POST /api/raw-signals/import、task-15）。content は貼付 / ファイルの生文字列。
 * json / csv とも文字列で送る（parser が両対応）。origin は送らず既定 import になる（§10.1）。
 * 成功時は { batch, pending, invalid } を行数に畳んで返す（quarantine で確認するため詳細は再取得）。
 */
export async function submitImport(
  params: { format: ImportFormat; content: string; note?: string },
  fetcher: typeof fetch = fetch,
): Promise<ImportSummary> {
  const res = await fetcher(IMPORT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: params.format, content: params.content, note: params.note }),
  });
  const data = await readData<{
    batch: { id: string; format: string };
    pending: unknown[];
    invalid: unknown[];
  }>(res, "import に失敗しました");
  return {
    batchId: data.batch.id,
    format: data.batch.format,
    pendingCount: data.pending.length,
    invalidCount: data.invalid.length,
  };
}

const TEXTAREA_STYLE = {
  width: "100%",
  minHeight: 160,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
  padding: "8px 12px",
  border: "1px solid #d0d5dd",
  borderRadius: 8,
  resize: "vertical" as const,
};

const FIELD_STYLE = { display: "flex", flexDirection: "column" as const, gap: 4, fontSize: 12 };

export type ImportDropzoneProps = {
  /** import 成功時のコールバック。呼び出し側が batchId を受け取り quarantine を表示する。 */
  onImported: (summary: ImportSummary) => void;
  /** テスト用の fetch 差し替え（既定は global fetch）。 */
  fetcher?: typeof fetch;
};

/**
 * Import 投入フォーム。フォーマット選択＋貼付テキスト＋ファイルアップロードを 1 つにまとめ、
 * submitImport で quarantine へ投入する。空内容は送信不可。
 */
export function ImportDropzone({ onImported, fetcher = fetch }: ImportDropzoneProps) {
  const [format, setFormat] = useState<ImportFormat>("json");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ファイルを読み、テキストエリアへ流し込む。拡張子から format を推定（手動変更も可）。
  // イベントハンドラ内の setState なので effect/render の lint 制約には掛からない。
  const handleFile = useCallback((file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setContent(typeof reader.result === "string" ? reader.result : "");
      const name = file.name.toLowerCase();
      if (name.endsWith(".csv")) setFormat("csv");
      else if (name.endsWith(".json")) setFormat("json");
    };
    reader.readAsText(file);
  }, []);

  const handleSubmit = useCallback(() => {
    if (submitting || isBlankContent(content)) return;
    setSubmitting(true);
    setError(null);
    void (async () => {
      try {
        const summary = await submitImport({ format, content }, fetcher);
        onImported(summary);
        setContent("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "import に失敗しました");
      } finally {
        setSubmitting(false);
      }
    })();
  }, [submitting, content, format, fetcher, onImported]);

  const canSubmit = !isBlankContent(content) && !submitting;

  return (
    <section
      style={{
        border: "1px solid #eaecf0",
        borderRadius: 12,
        padding: 16,
        marginBottom: 24,
        background: "#ffffff",
      }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginBottom: 12 }}>
        <label style={FIELD_STYLE}>
          <span style={{ color: "#667085" }}>フォーマット</span>
          <Select
            options={IMPORT_FORMAT_OPTIONS}
            value={format}
            onChange={(e) => setFormat(e.target.value as ImportFormat)}
            aria-label="取り込みフォーマット"
          />
        </label>
        <label style={FIELD_STYLE}>
          <span style={{ color: "#667085" }}>ファイルから読み込み</span>
          <input
            type="file"
            accept=".json,.csv,application/json,text/csv"
            onChange={(e) => handleFile(e.target.files?.[0])}
            aria-label="取り込みファイル"
          />
        </label>
      </div>

      <label style={{ ...FIELD_STYLE, gap: 4 }}>
        <span style={{ color: "#667085" }}>
          貼り付け（JSON は {"{ rawSignals: [...] }"} / CSV は固定ヘッダ）
        </span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={
            format === "json"
              ? '{ "rawSignals": [ { "sourceType": "app_store", "rawText": "…" } ] }'
              : "sourceType,rawText,observedEntity\napp_store,値上げの兆候,Example App"
          }
          style={TEXTAREA_STYLE}
          aria-label="取り込み内容"
        />
      </label>

      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13, marginTop: 8 }}>
          {error}
        </p>
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
          {submitting ? "取り込み中…" : "quarantine に取り込む"}
        </Button>
      </div>
    </section>
  );
}
