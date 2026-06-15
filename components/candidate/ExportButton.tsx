"use client";

import { useState } from "react";

import { Button } from "../ui";

// task-32 — Candidate export 導線（spec v2 §10.2 / §10.3）。
// 候補詳細から Markdown / Deep Research プロンプトを「コピー」または「ダウンロード」する。
// 取得は GET /api/candidates/[id]/export?format=markdown|deep-research（task-32）を薄く叩くだけ。
//
// 設計（既存 UI の流儀）: endpoint 構築・取得は純関数（fetcher DI）に切り出し、依存追加なしの
// node テストで駆動する。コピー/ダウンロードのブラウザ副作用（clipboard / a[download]）は薄い
// ヘルパに閉じ込め、container だけ local state（処理中・通知）を持つ。DOM 非依存方針のため
// テストは fetcher 経由のデータ経路を検証し、副作用ヘルパ自体は対象にしない。

/** export 形式（API の ?format と一致）。 */
export type ExportFormat = "markdown" | "deep-research";

/** 形式の表示ラベル。 */
export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  markdown: "Markdown",
  "deep-research": "Deep Research",
};

/** export endpoint（?format 付き）。 */
export function exportEndpoint(id: string, format: ExportFormat): string {
  return `/api/candidates/${id}/export?format=${format}`;
}

/** ダウンロード時の filename（API の Content-Disposition と整合する命名）。 */
export function exportFilename(id: string, format: ExportFormat): string {
  return format === "markdown" ? `${id}.md` : `${id}-deep-research.md`;
}

/**
 * export 本文（Markdown 文字列）を取得する。!ok は throw。fetcher は DI 可能。
 * 本文は text/markdown のため res.text() で受ける。
 */
export async function fetchExport(
  id: string,
  format: ExportFormat,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const res = await fetcher(exportEndpoint(id, format), {
    headers: { Accept: "text/markdown" },
  });
  if (!res.ok) {
    throw new Error(`export の取得に失敗しました（${res.status}）`);
  }
  return res.text();
}

/** クリップボードへコピーする（ブラウザ副作用）。Clipboard API 不在なら throw。 */
async function copyToClipboard(textValue: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    throw new Error("この環境ではコピーできません");
  }
  await navigator.clipboard.writeText(textValue);
}

/** Markdown を .md ファイルとしてダウンロードする（ブラウザ副作用）。 */
function downloadMarkdown(filename: string, textValue: string): void {
  const blob = new Blob([textValue], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export type ExportButtonProps = {
  candidateId: string;
};

/**
 * export 導線コンテナ。形式（Markdown / Deep Research）ごとにコピー / ダウンロードを提供する。
 * 取得は fetchExport（純関数）に委譲し、成功/失敗を通知へ反映する。
 */
export function ExportButton({ candidateId }: ExportButtonProps) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCopy(format: ExportFormat) {
    if (!candidateId || busy) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const content = await fetchExport(candidateId, format);
      await copyToClipboard(content);
      setNotice(`${EXPORT_FORMAT_LABELS[format]} をコピーしました`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "コピーに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload(format: ExportFormat) {
    if (!candidateId || busy) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const content = await fetchExport(candidateId, format);
      downloadMarkdown(exportFilename(candidateId, format), content);
      setNotice(`${EXPORT_FORMAT_LABELS[format]} をダウンロードしました`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ダウンロードに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  const formats: ExportFormat[] = ["markdown", "deep-research"];

  return (
    <section aria-label="エクスポート">
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>エクスポート</h2>
      <p style={{ color: "#667085", fontSize: 13, margin: "0 0 8px" }}>
        候補を Markdown / Deep Research プロンプト（不足 Evidence 自動算出）で出力します（§10.2 /
        §10.3）。
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {formats.map((format) => (
          <div key={format} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ minWidth: 110, fontSize: 13 }}>{EXPORT_FORMAT_LABELS[format]}</span>
            <Button variant="secondary" disabled={busy} onClick={() => void handleCopy(format)}>
              コピー
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void handleDownload(format)}>
              ダウンロード
            </Button>
          </div>
        ))}
      </div>
      {notice ? (
        <p role="status" style={{ color: "#1a7f3c", fontSize: 13 }}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13 }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
