"use client";

import { useState } from "react";

import { Button, Modal, Select, type SelectOption } from "../ui";
import { REJECTED_REASON_CODE_VALUES, type RejectedReasonCode } from "../../lib/validation/enums";

// task-21 — promote / reject の操作ロジックとモーダル（spec v2 §8.9 / §15.1 / §9.5）。
//
// promote: POST /api/candidates/[id]/promote（task-21 の昇格 API）。stage を1段昇格する
//   人間操作（§8.9 自動昇格しない）。ゲート未通過は API が 422＋不足理由を返すため、その
//   reasons を呼び出し側に伝わるエラーメッセージへ畳む。
// reject: POST /api/candidates/[id]/reject（task-13）。reasonCode（enum）必須（§15.1 傾向分析）。
//   未選択では送信不可にする（モーダルの確定ボタンを無効化＋呼び出し前ガード）。自由文補足は任意。
//
// 操作（送信）ロジックは純関数として切り出し、依存追加なしの node テストで駆動する。
// reasonCode の選択肢は task-02 の enum 値タプルから生成する（文字列直書きしない）。

/** reject 理由コードの表示ラベル（enum 値 → 日本語）。enum を正とし、未知値は値そのものを出す。 */
const REJECT_REASON_LABELS: Record<RejectedReasonCode, string> = {
  no_purchaser: "買い手が不在（誰が払うか不明）",
  free_only: "無料需要しかない",
  legal_risk: "規制・法務リスクが重い",
  too_competitive: "競合が多すぎる",
  weak_mobile_need: "モバイル需要が弱い",
  high_ai_cost: "AI コストが高すぎる",
  untestable: "検証不能",
  low_pain: "痛みが弱い",
  no_form_fit: "形態適合がない（モバイル/SaaS/AI のどれにも合わない）",
};

/**
 * reasonCode セレクトの選択肢。先頭に空 option（未選択）を置き、続けて enum 値を並べる。
 * enum（REJECTED_REASON_CODE_VALUES）を反復して生成するため、コード追加は enum 追加で追従する。
 */
export const REJECT_REASON_OPTIONS: SelectOption[] = [
  { value: "", label: "理由コードを選択（必須）" },
  ...REJECTED_REASON_CODE_VALUES.map((code) => ({
    value: code,
    label: REJECT_REASON_LABELS[code],
  })),
];

/** reasonCode が選択済みか（未選択＝送信不可）。§15.1: コード無しの棄却を構造的に禁止する。 */
export function canSubmitReject(reasonCode: string): boolean {
  return reasonCode.trim().length > 0;
}

/** promote / reject の endpoint。 */
export function promoteEndpoint(id: string): string {
  return `/api/candidates/${id}/promote`;
}
export function rejectEndpoint(id: string): string {
  return `/api/candidates/${id}/reject`;
}

/** API の { error: { message, reasons? } } を 1 行のメッセージへ畳む（reasons があれば併記）。 */
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

/**
 * promote（昇格）。POST /promote。fetcher は DI 可能。
 * !ok は throw。ゲート未通過（422）は API の reasons をメッセージに畳んで伝える
 * （UI 側で「なぜ昇格できないか」を表示できるようにする）。
 */
export async function promoteCandidate(id: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  const res = await fetcher(promoteEndpoint(id), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "昇格に失敗しました"));
  }
  const body = (await res.json()) as { data?: unknown };
  return body.data;
}

/** reject の入力（reasonCode 必須・reason 任意）。 */
export type RejectInput = { reasonCode: string; reason?: string };

/**
 * reject（棄却）。POST /reject。reasonCode 未選択は API を呼ばず throw（送信不可）。
 * 自由文 reason は非空のときだけ含める。!ok は throw。
 */
export async function rejectCandidate(
  id: string,
  input: RejectInput,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  if (!canSubmitReject(input.reasonCode)) {
    throw new Error("棄却理由コードを選択してください");
  }
  const reason = input.reason?.trim();
  const res = await fetcher(rejectEndpoint(id), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rejectedReasonCode: input.reasonCode,
      ...(reason ? { rejectedReason: reason } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "棄却に失敗しました"));
  }
  const body = (await res.json()) as { data?: unknown };
  return body.data;
}

const FIELD_STYLE = { display: "block", marginBottom: 12 } as const;
const LABEL_STYLE = { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 } as const;

export type RejectModalProps = {
  open: boolean;
  onClose: () => void;
  /** 確定（reasonCode 選択済みでのみ呼ばれる）。実際の送信は親が rejectCandidate で行う。 */
  onSubmit: (input: RejectInput) => void;
  /** 送信中（ボタンを無効化）。 */
  submitting?: boolean;
};

/**
 * 棄却モーダル（reasonCode 必須）。enum セレクト＋自由文補足。reasonCode 未選択では
 * 確定ボタンを無効化し、送信できない（§15.1）。閉じると入力はリセットされる。
 */
export function RejectModal({ open, onClose, onSubmit, submitting }: RejectModalProps) {
  const [reasonCode, setReasonCode] = useState("");
  const [reason, setReason] = useState("");

  function handleClose() {
    setReasonCode("");
    setReason("");
    onClose();
  }

  function handleConfirm() {
    if (!canSubmitReject(reasonCode) || submitting) return;
    onSubmit({ reasonCode, reason });
  }

  const disabled = !canSubmitReject(reasonCode) || Boolean(submitting);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="この候補を棄却する"
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={handleClose} disabled={submitting}>
            キャンセル
          </Button>
          <Button variant="danger" onClick={handleConfirm} disabled={disabled}>
            {submitting ? "棄却中…" : "棄却する"}
          </Button>
        </div>
      }
    >
      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>棄却理由コード（必須）</span>
        <Select
          options={REJECT_REASON_OPTIONS}
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value)}
          aria-invalid={canSubmitReject(reasonCode) ? undefined : true}
        />
      </label>
      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>補足（任意）</span>
        <textarea
          className="mi-input"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="棄却の背景・補足（任意）"
          style={{ resize: "vertical", fontFamily: "inherit" }}
        />
      </label>
      {!canSubmitReject(reasonCode) ? (
        <p style={{ fontSize: 12, color: "#667085" }}>
          理由コードを選ぶと棄却できます（傾向分析のため必須・§15.1）。
        </p>
      ) : null}
    </Modal>
  );
}
