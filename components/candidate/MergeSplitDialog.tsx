"use client";

import { useState } from "react";

import { Button, Modal } from "../ui";

// task-31 — merge / split 操作ダイアログ（spec v2 §15.2 / §15.3）。
// merge: POST /api/candidates/[id]/merge { absorbedId, reason } — [id] を survivor として
//   absorbedId を吸収する。split: POST /api/candidates/[id]/split { evidenceIds, reason, title? }
//   — [id] を source として複製を作り、指定 Evidence を新候補へ移す。どちらも理由必須（§15.3）。
//
// 設計（既存 UI の流儀）: 送信ロジックは純関数（fetcher DI）として切り出し、依存追加なしの
// node テストで駆動する。確定可否（必須項目の充足）も純関数にする。モーダル本体だけ local
// state を持つ。成功時は親へ onDone を通知し、画面（履歴・判断ログ・プロット）を再取得させる。

/** API の { error: { message, reasons? } } を 1 行へ畳む（reasons があれば併記）。 */
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; reasons?: string[] } };
    const base = body.error?.message ?? `${fallback}（${res.status}）`;
    const reasons = body.error?.reasons;
    return reasons && reasons.length > 0 ? `${base}：${reasons.join(" / ")}` : base;
  } catch {
    return `${fallback}（${res.status}）`;
  }
}

export function mergeEndpoint(id: string): string {
  return `/api/candidates/${id}/merge`;
}
export function splitEndpoint(id: string): string {
  return `/api/candidates/${id}/split`;
}

/** merge 入力（吸収側 ID・理由いずれも必須・空白不可）。 */
export type MergeInput = { absorbedId: string; reason: string };
/** split 入力（理由必須・移送 Evidence ID 群・任意の新候補タイトル）。 */
export type SplitInput = { evidenceIds: string[]; reason: string; title?: string };

/** merge を確定できるか（吸収側 ID・理由がともに非空白）。 */
export function canSubmitMerge(absorbedId: string, reason: string): boolean {
  return absorbedId.trim().length > 0 && reason.trim().length > 0;
}
/** split を確定できるか（理由が非空白。Evidence 0 件でも複製は作れる）。 */
export function canSubmitSplit(reason: string): boolean {
  return reason.trim().length > 0;
}

/** 改行・カンマ・空白区切りのテキストを ID 配列へ正規化する（空要素は捨てる）。 */
export function parseIdList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * merge（統合）。POST /merge。survivorId（残す側）の path に absorbedId を吸収する。
 * 未充足（吸収側 ID / 理由が空）は API を呼ばず throw。!ok は API の reasons を畳んで throw。
 */
export async function submitMerge(
  survivorId: string,
  input: MergeInput,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  if (!canSubmitMerge(input.absorbedId, input.reason)) {
    throw new Error("吸収する候補 ID と理由を入力してください");
  }
  const res = await fetcher(mergeEndpoint(survivorId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ absorbedId: input.absorbedId.trim(), reason: input.reason.trim() }),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "統合に失敗しました"));
  }
  const body = (await res.json()) as { data?: unknown };
  return body.data;
}

/**
 * split（分割）。POST /split。sourceId（分割元）の複製を作り、指定 Evidence を新候補へ移す。
 * 未充足（理由が空）は API を呼ばず throw。title は非空のときだけ含める。!ok は throw。
 */
export async function submitSplit(
  sourceId: string,
  input: SplitInput,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  if (!canSubmitSplit(input.reason)) {
    throw new Error("分割の理由を入力してください");
  }
  const title = input.title?.trim();
  const res = await fetcher(splitEndpoint(sourceId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      evidenceIds: input.evidenceIds,
      reason: input.reason.trim(),
      ...(title ? { title } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "分割に失敗しました"));
  }
  const body = (await res.json()) as { data?: unknown };
  return body.data;
}

const FIELD_STYLE = { display: "block", marginBottom: 12 } as const;
const LABEL_STYLE = { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 } as const;
const HINT_STYLE = { fontSize: 12, color: "#667085" } as const;

type Mode = "merge" | "split";

export type MergeSplitDialogProps = {
  open: boolean;
  /** 分割元 / 残す側（survivor）の候補 ID（= path の [id]）。 */
  candidateId: string;
  onClose: () => void;
  /** 成功時に呼ばれる（親で履歴・判断ログ・プロットを取り直す）。 */
  onDone: (result: unknown) => void;
};

/**
 * merge / split ダイアログ。モード切替で 1 つのモーダルに集約する。送信は submitMerge /
 * submitSplit（純関数）に委譲し、成功で onDone（再取得）、失敗はモーダル内にエラー表示する。
 */
export function MergeSplitDialog({ open, candidateId, onClose, onDone }: MergeSplitDialogProps) {
  const [mode, setMode] = useState<Mode>("merge");
  const [absorbedId, setAbsorbedId] = useState("");
  const [reason, setReason] = useState("");
  const [evidenceIdsText, setEvidenceIdsText] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setMode("merge");
    setAbsorbedId("");
    setReason("");
    setEvidenceIdsText("");
    setTitle("");
    setError(null);
    setSubmitting(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  const disabled =
    submitting ||
    (mode === "merge" ? !canSubmitMerge(absorbedId, reason) : !canSubmitSplit(reason));

  async function handleConfirm() {
    if (disabled) return;
    setSubmitting(true);
    setError(null);
    try {
      const result =
        mode === "merge"
          ? await submitMerge(candidateId, { absorbedId, reason })
          : await submitSplit(candidateId, {
              evidenceIds: parseIdList(evidenceIdsText),
              reason,
              title,
            });
      reset();
      onDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作に失敗しました");
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="候補の統合 / 分割"
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={handleClose} disabled={submitting}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={() => void handleConfirm()} disabled={disabled}>
            {submitting ? "実行中…" : mode === "merge" ? "統合する" : "分割する"}
          </Button>
        </div>
      }
    >
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }} role="tablist" aria-label="操作種別">
        <Button
          variant={mode === "merge" ? "primary" : "ghost"}
          onClick={() => setMode("merge")}
          disabled={submitting}
        >
          統合（merge）
        </Button>
        <Button
          variant={mode === "split" ? "primary" : "ghost"}
          onClick={() => setMode("split")}
          disabled={submitting}
        >
          分割（split）
        </Button>
      </div>

      {mode === "merge" ? (
        <label style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>吸収する候補 ID（必須）</span>
          <input
            className="mi-input"
            value={absorbedId}
            onChange={(e) => setAbsorbedId(e.target.value)}
            placeholder="この候補へ統合する側の id"
          />
          <span style={HINT_STYLE}>
            この候補（表示中）を残す側（survivor）とし、入力 ID の候補を吸収して archived にします。
          </span>
        </label>
      ) : (
        <>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>新候補へ移す Evidence ID（任意・改行/カンマ区切り）</span>
            <textarea
              className="mi-input"
              rows={3}
              value={evidenceIdsText}
              onChange={(e) => setEvidenceIdsText(e.target.value)}
              placeholder="evidence-id-1, evidence-id-2"
              style={{ resize: "vertical", fontFamily: "inherit" }}
            />
            <span style={HINT_STYLE}>
              指定が無くても複製は作れます。元候補に属さない Evidence は無視されます。
            </span>
          </label>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>新候補のタイトル（任意）</span>
            <input
              className="mi-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="未指定なら元候補のタイトルを引き継ぐ"
            />
          </label>
        </>
      )}

      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>理由（必須・§15.3）</span>
        <textarea
          className="mi-input"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={mode === "merge" ? "統合する判断の理由" : "分割する判断の理由"}
          style={{ resize: "vertical", fontFamily: "inherit" }}
        />
      </label>

      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13 }}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

export type MergeSplitLauncherProps = {
  candidateId: string;
  /** 統合 / 分割の成功時に呼ばれる（親で画面を取り直す）。 */
  onChanged?: () => void;
};

/**
 * 統合 / 分割の起動導線（ボタン＋ダイアログ）。詳細画面に置く。
 * 成功時に通知を出し、親へ onChanged（再取得）を伝える。
 */
export function MergeSplitLauncher({ candidateId, onChanged }: MergeSplitLauncherProps) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function handleDone() {
    setOpen(false);
    setNotice("統合 / 分割を実行しました");
    onChanged?.();
  }

  return (
    <section aria-label="統合 / 分割">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>統合 / 分割</h2>
        <Button
          variant="ghost"
          onClick={() => {
            setNotice(null);
            setOpen(true);
          }}
        >
          統合 / 分割を行う
        </Button>
      </div>
      {notice ? (
        <p role="status" style={{ color: "#1a7f3c", fontSize: 13 }}>
          {notice}
        </p>
      ) : null}
      <p style={{ color: "#667085", fontSize: 13 }}>
        重複候補の統合（merge）や、混在した候補の分割（split）を行います（§15.2）。
      </p>
      {open ? (
        <MergeSplitDialog
          open
          candidateId={candidateId}
          onClose={() => setOpen(false)}
          onDone={handleDone}
        />
      ) : null}
    </section>
  );
}
