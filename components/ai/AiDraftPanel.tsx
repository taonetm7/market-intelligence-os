"use client";

import { useState, type ReactNode } from "react";

import { originSchema } from "../../lib/validation/enums";
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

/** AI 由来データを quarantine へ投入する import エンドポイント（task-15・既存）。 */
export const QUARANTINE_INTAKE_URL = "/api/raw-signals/import";

/** quarantine 投入の結果サマリ（batchId と件数）。人間が後で accept する導線に使う。 */
export interface QuarantineIntakeSummary {
  batchId: string;
  pendingCount: number;
  invalidCount: number;
}

/**
 * AI 由来の RawSignal 下書きを quarantine へ **origin="ai"** で投入する（§11.2）。
 * 既存 import エンドポイント（task-15）を呼ぶだけで、ここでも DB を直接は触らない。
 * RawSignal は人間が quarantine を accept したときに初めて作られる（必ず関門を通す）。
 * origin は直書きせず originSchema 経由（enum 直書き禁止）。fetcher は DI 可能。
 */
export async function submitProposalToQuarantine(
  drafts: unknown[],
  fetcher: typeof fetch = fetch,
): Promise<QuarantineIntakeSummary> {
  const res = await fetcher(QUARANTINE_INTAKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      format: "json",
      content: { rawSignals: drafts },
      origin: originSchema.enum.ai,
    }),
  });
  if (!res.ok) {
    throw new Error(`quarantine への投入に失敗しました（${res.status}）`);
  }
  const json = (await res.json()) as {
    data?: { batch?: { id?: string }; pending?: unknown[]; invalid?: unknown[] };
  };
  const data = json.data ?? {};
  return {
    batchId: data.batch?.id ?? "",
    pendingCount: data.pending?.length ?? 0,
    invalidCount: data.invalid?.length ?? 0,
  };
}

export interface AiDraftPanelProps {
  action: AiDraftAction;
  /** ボタン表示ラベル。 */
  label: string;
  /** 送信ボディを組み立てる。必須入力が未充足なら null を返す（ボタンを実行不可にする）。 */
  buildBody: () => unknown | null;
  /** 取得した proposed を描画する（提案表示専用）。 */
  renderProposed: (proposed: unknown) => ReactNode;
  /**
   * 任意: proposed を「quarantine へ送る RawSignal 下書き配列」に変換する。返すと
   * 「quarantine へ送る（origin=ai）」導線が表示され、押下で {@link submitProposalToQuarantine} を
   * 呼ぶ（§11.2 の draft→人間 accept 経路）。RawSignal を直接生成する画面でのみ渡す。
   * null を返すと投入できない（未充足）。未指定なら導線を出さない（提案表示のみ）。
   */
  buildQuarantineDrafts?: (proposed: unknown) => unknown[] | null;
}

/**
 * 「AI下書き」ボタン + 提案表示。押下で /api/ai/[action] を叩き、proposed を提案として表示する。
 * DB へは自動反映しない（人間が手動で反映）。キー未設定時は無効である旨を表示し、エラーにしない。
 */
export function AiDraftPanel({
  action,
  label,
  buildBody,
  renderProposed,
  buildQuarantineDrafts,
}: AiDraftPanelProps) {
  const [busy, setBusy] = useState(false);
  const [proposed, setProposed] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intake, setIntake] = useState<QuarantineIntakeSummary | null>(null);

  async function run() {
    if (busy) return;
    const body = buildBody();
    if (body === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setProposed(null);
    setIntake(null);
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

  async function sendToQuarantine() {
    if (busy || proposed === null || buildQuarantineDrafts === undefined) return;
    const drafts = buildQuarantineDrafts(proposed);
    if (drafts === null || drafts.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const summary = await submitProposalToQuarantine(drafts);
      setIntake(summary);
      setNotice(
        `quarantine へ origin=ai で投入しました（batch: ${summary.batchId}）。` +
          "実体（RawSignal）への反映は隔離レビューで人間が accept したときだけ行われます。",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "quarantine への投入に失敗しました");
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
          {buildQuarantineDrafts !== undefined ? (
            <div style={{ marginTop: 8 }}>
              <Button
                variant="secondary"
                disabled={busy || intake !== null}
                onClick={() => void sendToQuarantine()}
              >
                {intake !== null ? "quarantine 投入済み" : "quarantine へ送る（origin=ai）"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
