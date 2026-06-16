"use client";

import { useState } from "react";

import { Badge, Button, Modal } from "../ui";
import { parseIdList, submitMerge, submitSplit } from "../candidate/MergeSplitDialog";
import type { FeatureKey, FieldMatch } from "../../lib/duplicate/similarity";

// task-35 — 重複候補ペアのレビューカード（spec v2 §9.7）。
// 似た 2 候補を左右に並べ、一致した項目（matched 理由）をハイライトして、人間が
// Merge / Split / Keep Separate / Not Duplicate を判断する。
//
// 設計（既存 UI の流儀）:
// - 類似度・マージ実体は持たない。merge / split は task-30 の API を呼ぶ MergeSplitDialog の
//   純関数（submitMerge / submitSplit・fetcher DI）を再利用する（UI から再実装しない）。
// - 誤操作防止（Phase 2 / Codex 指摘1）: Merge / Split は即時実行せず確認ダイアログ（取消可能）を
//   経由する。survivor（残す側）/ 分割元を未選択のままでは Merge / Split を実行できない。
// - Keep Separate / Not Duplicate（Phase 2 / 指摘2）: 抑制を **サーバへ永続化**する
//   （POST /api/duplicates/dismiss）。一覧（GET /api/duplicates）が当該ペアを除外するため、
//   リロード/再訪問・再取得で復活しない。
// - 表示・判定ロジックは純関数として切り出し、依存追加なしの静的描画 / node テストで駆動する。

/** カードが表示する候補（§9.7 比較項目の最小ビュー）。 */
export interface DuplicateCandidateView {
  id: string;
  displayId: string;
  title: string;
  problemFamily: string | null;
  targetUser: string | null;
  contextTrigger: string | null;
  painStatement: string | null;
  currentSubstitute: string | null;
  stage: string;
}

/** 重複ペア 1 件分（API の DuplicatePair をクライアント表示用に絞ったもの）。 */
export interface DuplicatePairView {
  a: DuplicateCandidateView;
  b: DuplicateCandidateView;
  score: number;
  matched: FieldMatch[];
}

/** カード上の判断アクション。 */
export type PairAction = "merge" | "split" | "keep_separate" | "not_duplicate";

/** 抑制系アクション（サーバ永続化の対象）。 */
export type DismissAction = "keep_separate" | "not_duplicate";

/** どちらを残す側（survivor）/ 分割元にするか。null は未選択。 */
export type SurvivorSide = "a" | "b";

/** 抑制保存 API のエンドポイント。 */
export const DISMISS_ENDPOINT = "/api/duplicates/dismiss";

/** 左右に並べて比較するテキスト項目（§9.7・tags は候補カラムでないので一致理由側で扱う）。 */
export const COMPARISON_FIELDS: { key: Exclude<FeatureKey, "tags">; label: string }[] = [
  { key: "problemFamily", label: "課題ファミリ" },
  { key: "painStatement", label: "課題（痛み）" },
  { key: "targetUser", label: "対象ユーザー" },
  { key: "contextTrigger", label: "きっかけ" },
  { key: "currentSubstitute", label: "現在の代替手段" },
];

/** 全 FeatureKey の日本語ラベル（一致理由の表示用）。 */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  problemFamily: "課題ファミリ",
  painStatement: "課題（痛み）",
  targetUser: "対象ユーザー",
  contextTrigger: "きっかけ",
  currentSubstitute: "現在の代替手段",
  tags: "タグ",
};

/** ペアの安定キー（2 候補 ID を整列して結合。左右の順序に依らない）。 */
export function pairKey(pair: { a: { id: string }; b: { id: string } }): string {
  return [pair.a.id, pair.b.id].sort().join("__");
}

/** 一致した素性キーの集合（ハイライト判定用）。 */
export function matchedFieldSet(matched: FieldMatch[]): Set<FeatureKey> {
  return new Set(matched.map((m) => m.field));
}

/** スコアを百分率（整数）表記にする。 */
export function formatScorePct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** survivor / 分割元の選択が済んでいるか（Merge / Split の実行可否）。 */
export function canAct(survivor: SurvivorSide | null): survivor is SurvivorSide {
  return survivor !== null;
}

/** survivor / absorbed の ID を side から解決する。 */
export function resolveMergeIds(
  pair: DuplicatePairView,
  survivor: SurvivorSide,
): { survivorId: string; absorbedId: string } {
  return survivor === "a"
    ? { survivorId: pair.a.id, absorbedId: pair.b.id }
    : { survivorId: pair.b.id, absorbedId: pair.a.id };
}

/** side から候補本体を取り出す。 */
export function candidateOf(pair: DuplicatePairView, side: SurvivorSide): DuplicateCandidateView {
  return side === "a" ? pair.a : pair.b;
}

/** Merge の既定理由（重複レビュー由来・空にしない＝API の必須を満たす）。 */
export function defaultMergeReason(
  survivor: DuplicateCandidateView,
  absorbed: DuplicateCandidateView,
): string {
  return `重複レビュー: ${absorbed.displayId} を ${survivor.displayId} へ統合`;
}

/** Split の既定理由。 */
export function defaultSplitReason(source: DuplicateCandidateView): string {
  return `重複レビュー: ${source.displayId} を分割`;
}

/** 抑制の既定理由。 */
export function defaultDismissReason(kind: DismissAction): string {
  return kind === "keep_separate" ? "重複レビュー: 別物として残す" : "重複レビュー: 重複ではない";
}

/**
 * ペアの抑制を永続化する（Keep Separate / Not Duplicate）。POST /api/duplicates/dismiss。
 * 成功で保存された pairKey を返す。!ok は throw。
 */
export async function submitDismiss(
  pair: DuplicatePairView,
  kind: DismissAction,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetcher(DISMISS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateAId: pair.a.id,
      candidateBId: pair.b.id,
      kind,
      reason: defaultDismissReason(kind),
    }),
  });
  if (!res.ok) {
    throw new Error(`抑制の保存に失敗しました（${res.status}）`);
  }
  const body = (await res.json()) as { data?: unknown };
  return body.data;
}

const CELL_BASE = { padding: "4px 8px", fontSize: 13, verticalAlign: "top" } as const;
const FIELD_STYLE = { display: "block", marginBottom: 12 } as const;
const LABEL_STYLE = { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 } as const;
const HINT_STYLE = { fontSize: 12, color: "#667085" } as const;

function fieldValue(candidate: DuplicateCandidateView, key: Exclude<FeatureKey, "tags">): string {
  return candidate[key] ?? "—";
}

/** 確認ダイアログ共通の footer（キャンセル / 実行）。 */
function ConfirmFooter({
  confirmLabel,
  busyLabel,
  onConfirm,
  onCancel,
  busy,
  disabled,
}: {
  confirmLabel: string;
  busyLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        キャンセル
      </Button>
      <Button variant="primary" onClick={onConfirm} disabled={disabled}>
        {busy ? busyLabel : confirmLabel}
      </Button>
    </div>
  );
}

export type MergeConfirmDialogProps = {
  open: boolean;
  survivor: DuplicateCandidateView;
  absorbed: DuplicateCandidateView;
  reason: string;
  onReasonChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
};

/** 統合（Merge）の確認ダイアログ。誤マージ防止の取消導線（§Phase2 指摘1）。 */
export function MergeConfirmDialog({
  open,
  survivor,
  absorbed,
  reason,
  onReasonChange,
  onConfirm,
  onCancel,
  busy,
  error,
}: MergeConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="統合の確認"
      footer={
        <ConfirmFooter
          confirmLabel="統合する"
          busyLabel="統合中…"
          onConfirm={onConfirm}
          onCancel={onCancel}
          busy={busy}
          disabled={busy || reason.trim().length === 0}
        />
      }
    >
      <p style={{ fontSize: 14 }}>
        「{absorbed.displayId}・{absorbed.title}」を「{survivor.displayId}・{survivor.title}」へ統合します。
        吸収された側（{absorbed.displayId}）は archived になります。
      </p>
      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>理由（必須・§15.3）</span>
        <textarea
          className="mi-input"
          rows={2}
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
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

export type SplitConfirmDialogProps = {
  open: boolean;
  source: DuplicateCandidateView;
  reason: string;
  onReasonChange: (v: string) => void;
  evidenceIdsText: string;
  onEvidenceIdsChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
};

/** 分割（Split）の確認ダイアログ。移送 Evidence を明示でき、取消可能（§Phase2 指摘1）。 */
export function SplitConfirmDialog({
  open,
  source,
  reason,
  onReasonChange,
  evidenceIdsText,
  onEvidenceIdsChange,
  onConfirm,
  onCancel,
  busy,
  error,
}: SplitConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="分割の確認"
      footer={
        <ConfirmFooter
          confirmLabel="分割する"
          busyLabel="分割中…"
          onConfirm={onConfirm}
          onCancel={onCancel}
          busy={busy}
          disabled={busy || reason.trim().length === 0}
        />
      }
    >
      <p style={{ fontSize: 14 }}>
        「{source.displayId}・{source.title}」を分割し、新しい候補を作成します。
      </p>
      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>新候補へ移す Evidence ID（任意・改行/カンマ区切り）</span>
        <textarea
          className="mi-input"
          rows={2}
          value={evidenceIdsText}
          onChange={(e) => onEvidenceIdsChange(e.target.value)}
          placeholder="evidence-id-1, evidence-id-2"
          style={{ resize: "vertical", fontFamily: "inherit" }}
        />
        <span style={HINT_STYLE}>
          指定が無くても複製は作れます（元候補に属さない Evidence は無視されます）。
        </span>
      </label>
      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>理由（必須・§15.3）</span>
        <textarea
          className="mi-input"
          rows={2}
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
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

type ConfirmMode = null | "merge" | "split";

export type DuplicatePairCardProps = {
  pair: DuplicatePairView;
  /** 判断が確定したときに呼ばれる（親で一覧を再取得する）。 */
  onResolved: (action: PairAction, pair: DuplicatePairView) => void;
  /** テスト用の fetch 差し替え（既定は global fetch）。 */
  fetcher?: typeof fetch;
};

/**
 * 重複ペア 1 件のレビューカード。左右の候補と一致理由を出し、survivor（残す側 / 分割元）を選んで
 * Merge / Split を確認ダイアログ経由で実行、もしくは Keep Separate / Not Duplicate でペアを抑制する。
 * 実体操作は task-30 API（submitMerge / submitSplit）/ 抑制 API（submitDismiss）に委譲し、成功で
 * onResolved（親で再取得）を通知する。
 */
export function DuplicatePairCard({ pair, onResolved, fetcher }: DuplicatePairCardProps) {
  const [survivor, setSurvivor] = useState<SurvivorSide | null>(null);
  const [confirm, setConfirm] = useState<ConfirmMode>(null);
  const [reason, setReason] = useState("");
  const [evidenceIdsText, setEvidenceIdsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matchedSet = matchedFieldSet(pair.matched);
  const selectable = canAct(survivor);

  function openMerge() {
    if (!canAct(survivor)) return;
    const keep = candidateOf(pair, survivor);
    const drop = candidateOf(pair, survivor === "a" ? "b" : "a");
    setReason(defaultMergeReason(keep, drop));
    setError(null);
    setConfirm("merge");
  }

  function openSplit() {
    if (!canAct(survivor)) return;
    setReason(defaultSplitReason(candidateOf(pair, survivor)));
    setEvidenceIdsText("");
    setError(null);
    setConfirm("split");
  }

  async function confirmMerge() {
    if (!canAct(survivor)) return;
    setBusy(true);
    setError(null);
    try {
      const { survivorId, absorbedId } = resolveMergeIds(pair, survivor);
      await submitMerge(survivorId, { absorbedId, reason }, fetcher);
      setConfirm(null);
      onResolved("merge", pair);
    } catch (e) {
      setError(e instanceof Error ? e.message : "統合に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function confirmSplit() {
    if (!canAct(survivor)) return;
    setBusy(true);
    setError(null);
    try {
      const source = candidateOf(pair, survivor);
      await submitSplit(source.id, { evidenceIds: parseIdList(evidenceIdsText), reason }, fetcher);
      setConfirm(null);
      onResolved("split", pair);
    } catch (e) {
      setError(e instanceof Error ? e.message : "分割に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(kind: DismissAction) {
    setBusy(true);
    setError(null);
    try {
      await submitDismiss(pair, kind, fetcher);
      onResolved(kind, pair);
    } catch (e) {
      setError(e instanceof Error ? e.message : "抑制の保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label={`重複候補ペア ${pair.a.displayId} / ${pair.b.displayId}`}
      style={{ border: "1px solid #e4e7ec", borderRadius: 8, padding: 16, marginBottom: 16 }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Badge tone="info">類似度 {formatScorePct(pair.score)}</Badge>
        <span style={{ fontSize: 13, color: "#667085" }}>
          一致理由:{" "}
          {pair.matched.length > 0
            ? pair.matched.map((m) => FEATURE_LABELS[m.field]).join(" / ")
            : "なし"}
        </span>
      </header>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...CELL_BASE, textAlign: "left", width: "20%" }}>項目</th>
            <th style={{ ...CELL_BASE, textAlign: "left" }}>
              {pair.a.displayId}・{pair.a.title}
            </th>
            <th style={{ ...CELL_BASE, textAlign: "left" }}>
              {pair.b.displayId}・{pair.b.title}
            </th>
          </tr>
        </thead>
        <tbody>
          {COMPARISON_FIELDS.map(({ key, label }) => {
            const hit = matchedSet.has(key);
            const cellStyle = hit
              ? { ...CELL_BASE, background: "#fff7e6", fontWeight: 600 }
              : CELL_BASE;
            return (
              <tr key={key}>
                <td style={{ ...CELL_BASE, color: "#667085" }}>
                  {label}
                  {hit ? (
                    <Badge tone="warning" className="mi-dup-match">
                      一致
                    </Badge>
                  ) : null}
                </td>
                <td style={cellStyle}>{fieldValue(pair.a, key)}</td>
                <td style={cellStyle}>{fieldValue(pair.b, key)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <fieldset style={{ border: "none", margin: "12px 0 8px", padding: 0 }}>
        <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
          対象候補を選択（Merge: 残す側 survivor / Split: 分割元）
        </legend>
        <label style={{ marginRight: 16, fontSize: 13 }}>
          <input
            type="radio"
            name={`survivor-${pairKey(pair)}`}
            checked={survivor === "a"}
            onChange={() => setSurvivor("a")}
          />{" "}
          {pair.a.displayId}
        </label>
        <label style={{ fontSize: 13 }}>
          <input
            type="radio"
            name={`survivor-${pairKey(pair)}`}
            checked={survivor === "b"}
            onChange={() => setSurvivor("b")}
          />{" "}
          {pair.b.displayId}
        </label>
        {!selectable ? (
          <p style={{ ...HINT_STYLE, marginTop: 4 }}>
            Merge / Split には対象候補の選択が必要です。
          </p>
        ) : null}
      </fieldset>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="primary" disabled={busy || !selectable} onClick={openMerge}>
          統合（Merge）
        </Button>
        <Button variant="secondary" disabled={busy || !selectable} onClick={openSplit}>
          分割（Split）
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void dismiss("keep_separate")}>
          別物として残す（Keep Separate）
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void dismiss("not_duplicate")}>
          重複でない（Not Duplicate）
        </Button>
      </div>

      {error && confirm === null ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13, marginTop: 8 }}>
          {error}
        </p>
      ) : null}

      {selectable ? (
        <>
          <MergeConfirmDialog
            open={confirm === "merge"}
            survivor={candidateOf(pair, survivor)}
            absorbed={candidateOf(pair, survivor === "a" ? "b" : "a")}
            reason={reason}
            onReasonChange={setReason}
            onConfirm={() => void confirmMerge()}
            onCancel={() => setConfirm(null)}
            busy={busy}
            error={confirm === "merge" ? error : null}
          />
          <SplitConfirmDialog
            open={confirm === "split"}
            source={candidateOf(pair, survivor)}
            reason={reason}
            onReasonChange={setReason}
            evidenceIdsText={evidenceIdsText}
            onEvidenceIdsChange={setEvidenceIdsText}
            onConfirm={() => void confirmSplit()}
            onCancel={() => setConfirm(null)}
            busy={busy}
            error={confirm === "split" ? error : null}
          />
        </>
      ) : null}
    </section>
  );
}
