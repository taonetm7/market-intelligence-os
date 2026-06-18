"use client";

import { useState, type ReactNode } from "react";

import { Button } from "../ui";

// task-39 — AI 下書き（draft 提案）UI の共通部品（spec v2 §11）。
//
// 各画面（task-17 正規化下書き / task-21 不足Evidence / task-32 調査プロンプト）に置く
// 「AI下書き」ボタン。POST /api/ai/[action] を叩いて proposed（提案）を取得し、**提案として
// 表示するだけ**で DB へは自動反映しない（人間が内容を確認し手動で反映＝§11.2 の draft→accept）。
//
// 設計（既存 UI の流儀）: fetch は純関数（fetcher DI）に切り出し、container だけ local state を持つ。
// 3 画面で同じボタン＋提案表示の振る舞いを共有するため 1 部品に集約する（重複インライン実装を避ける）。

/** /api/ai/[action] の action（suggest.ts の AI_ACTION_VALUES に対応）。 */
export type AiDraftAction =
  | "tag-suggest"
  | "normalize-draft"
  | "missing-evidence"
  | "research-prompt";

/** AI 提案の取得結果。enabled=false は API キー未設定（機能無効・エラー扱いにしない）。 */
export interface AiProposalResult {
  enabled: boolean;
  proposed?: unknown;
}

/**
 * POST /api/ai/[action] を叩いて提案を取得する。!ok は throw。enabled=false（キー未設定）は
 * 正常応答として返す。fetcher は DI 可能。
 */
export async function fetchAiProposal(
  action: AiDraftAction,
  body: unknown,
  fetcher: typeof fetch = fetch,
): Promise<AiProposalResult> {
  const res = await fetcher(`/api/ai/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`AI 提案の取得に失敗しました（${res.status}）`);
  }
  const json = (await res.json()) as { data?: { enabled?: boolean; proposed?: unknown } };
  const data = json.data ?? {};
  if (data.enabled === false) {
    return { enabled: false };
  }
  return { enabled: true, proposed: data.proposed };
}

export interface AiDraftPanelProps {
  action: AiDraftAction;
  /** ボタン表示ラベル。 */
  label: string;
  /** 送信ボディを組み立てる。必須入力が未充足なら null を返す（ボタンを実行不可にする）。 */
  buildBody: () => unknown | null;
  /** 取得した proposed を描画する（提案表示専用）。 */
  renderProposed: (proposed: unknown) => ReactNode;
}

/**
 * 「AI下書き」ボタン + 提案表示。押下で /api/ai/[action] を叩き、proposed を提案として表示する。
 * DB へは自動反映しない（人間が手動で反映）。キー未設定時は無効である旨を表示し、エラーにしない。
 */
export function AiDraftPanel({ action, label, buildBody, renderProposed }: AiDraftPanelProps) {
  const [busy, setBusy] = useState(false);
  const [proposed, setProposed] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    const body = buildBody();
    if (body === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setProposed(null);
    try {
      const result = await fetchAiProposal(action, body);
      if (!result.enabled) {
        setNotice("AI 機能は無効です（ANTHROPIC_API_KEY 未設定）");
        return;
      }
      setProposed(result.proposed ?? null);
      setNotice("AI 下書き（提案）です。内容を確認し、人間が手動で反映してください（自動反映しません）。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI 提案の取得に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <Button variant="secondary" disabled={busy} onClick={() => void run()}>
        {busy ? "AI 生成中…" : label}
      </Button>
      {notice ? (
        <p role="status" style={{ color: "#475467", fontSize: 12, marginTop: 4 }}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 12, marginTop: 4 }}>
          {error}
        </p>
      ) : null}
      {proposed !== null ? (
        <div
          style={{
            marginTop: 8,
            padding: 12,
            border: "1px dashed #d0d5dd",
            borderRadius: 8,
            fontSize: 13,
          }}
        >
          {renderProposed(proposed)}
        </div>
      ) : null}
    </div>
  );
}
