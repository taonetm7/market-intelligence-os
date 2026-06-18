"use client";

import { useCallback, useState } from "react";

import { PageHeader } from "../../components/layout/PageHeader";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";

// task-38 — Weekly Report 画面（spec v2 §9.9）。
// since（期間開始日）を指定して GET /api/reports/weekly を呼び、返ってきた Markdown を
// プレビュー表示する。コピー（クリップボード）/ ダウンロード（.md）で持ち出せる。
// 生成本体は API（純粋関数 lib/report/weekly.ts）が担うため、ここは入力・取得・持ち出しのみ。

/** "YYYY-MM-DD"（input[type=date] の value）。 */
function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 既定の since = 7 日前。 */
function defaultSince(): string {
  return ymd(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
}

export default function ReportsPage() {
  const [since, setSince] = useState<string>(defaultSince);
  const [markdown, setMarkdown] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const generate = useCallback(() => {
    setLoading(true);
    setError(null);
    setNotice(null);
    void (async () => {
      try {
        const url = since ? `/api/reports/weekly?since=${encodeURIComponent(since)}` : "/api/reports/weekly";
        const res = await fetch(url);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(body?.error?.message ?? `生成に失敗しました（${res.status}）`);
        }
        setMarkdown(await res.text());
        setNotice("週報を生成しました。");
      } catch (e) {
        setError(e instanceof Error ? e.message : "生成に失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, [since]);

  const copy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(markdown);
        setNotice("クリップボードにコピーしました。");
      } catch {
        setError("コピーに失敗しました（クリップボード権限を確認してください）。");
      }
    })();
  }, [markdown]);

  const download = useCallback(() => {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `weekly-report-${ymd(new Date())}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setNotice("Markdown をダウンロードしました。");
  }, [markdown]);

  const hasReport = markdown.trim() !== "";

  return (
    <div>
      <PageHeader
        title="Weekly Report"
        description="ScoreSnapshot の週次差分・判断ログ・棄却理由・Watchlist 差分から週報 Markdown を生成します。コピー / ダウンロードで持ち出せます。"
      />

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>期間開始（since）</span>
          <Input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            aria-label="期間開始"
          />
        </label>
        <Button variant="primary" onClick={generate} disabled={loading}>
          {loading ? "生成中…" : "週報を生成"}
        </Button>
        <Button variant="secondary" onClick={copy} disabled={!hasReport}>
          コピー
        </Button>
        <Button variant="secondary" onClick={download} disabled={!hasReport}>
          ダウンロード
        </Button>
      </div>

      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13, marginBottom: 12 }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          style={{
            background: "#eef4ff",
            border: "1px solid #b2ccff",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 13,
            marginBottom: 12,
          }}
        >
          {notice}
        </p>
      ) : null}

      {hasReport ? (
        <pre
          style={{
            background: "#0f172a",
            color: "#e2e8f0",
            borderRadius: 8,
            padding: 16,
            fontSize: 13,
            lineHeight: 1.6,
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {markdown}
        </pre>
      ) : (
        <p style={{ color: "#64748b", fontSize: 13 }}>
          期間を指定して「週報を生成」を押すと、ここに Markdown プレビューが表示されます。
        </p>
      )}
    </div>
  );
}
