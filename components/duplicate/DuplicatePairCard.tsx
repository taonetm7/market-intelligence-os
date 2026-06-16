"use client";

import { useState } from "react";

import { Badge, Button } from "../ui";
import { submitMerge, submitSplit } from "../candidate/MergeSplitDialog";
import type { FeatureKey, FieldMatch } from "../../lib/duplicate/similarity";

// task-35 — 重複候補ペアのレビューカード（spec v2 §9.7）。
// 似た 2 候補を左右に並べ、一致した項目（matched 理由）をハイライトして、人間が
// Merge / Split / Keep Separate / Not Duplicate を判断する。
//
// 設計（既存 UI の流儀）:
// - 類似度・マージ実体は持たない。merge / split は task-30 の API を呼ぶ MergeSplitDialog の
//   純関数（submitMerge / submitSplit・fetcher DI）を再利用する（UI から再実装しない）。
// - Keep Separate / Not Duplicate はサジェストからの抑制（最小実装＝一覧から除外）。永続化は
//   別タスク（モデル追加が要るため）。ここではペアを一覧から落とすことで「除外」を満たす。
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

/** どちらを残す側（survivor）にするか。 */
export type SurvivorSide = "a" | "b";

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

/** survivor / absorbed の ID を side から解決する。 */
export function resolveMergeIds(
  pair: DuplicatePairView,
  survivor: SurvivorSide,
): { survivorId: string; absorbedId: string } {
  return survivor === "a"
    ? { survivorId: pair.a.id, absorbedId: pair.b.id }
    : { survivorId: pair.b.id, absorbedId: pair.a.id };
}

/** Merge の既定理由（重複レビュー由来・空にしない＝API の必須を満たす）。 */
export function defaultMergeReason(survivor: DuplicateCandidateView, absorbed: DuplicateCandidateView): string {
  return `重複レビュー: ${absorbed.displayId} を ${survivor.displayId} へ統合`;
}

/** Split の既定理由。 */
export function defaultSplitReason(source: DuplicateCandidateView): string {
  return `重複レビュー: ${source.displayId} を分割`;
}

const CELL_BASE = { padding: "4px 8px", fontSize: 13, verticalAlign: "top" } as const;

function fieldValue(candidate: DuplicateCandidateView, key: Exclude<FeatureKey, "tags">): string {
  return candidate[key] ?? "—";
}

export type DuplicatePairCardProps = {
  pair: DuplicatePairView;
  /** 判断が確定したときに呼ばれる（親で一覧の再取得 / ペア除外を行う）。 */
  onResolved: (action: PairAction, pair: DuplicatePairView) => void;
  /** テスト用の fetch 差し替え（既定は global fetch）。 */
  fetcher?: typeof fetch;
};

/**
 * 重複ペア 1 件のレビューカード。左右の候補と一致理由を出し、survivor を選んで Merge、
 * もしくは Split / Keep Separate / Not Duplicate を行う。実体操作は task-30 API（submitMerge /
 * submitSplit）に委譲し、成功で onResolved（再取得 / 除外）を親へ通知する。
 */
export function DuplicatePairCard({ pair, onResolved, fetcher }: DuplicatePairCardProps) {
  const [survivor, setSurvivor] = useState<SurvivorSide>("a");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matchedSet = matchedFieldSet(pair.matched);

  async function run(action: PairAction) {
    setError(null);
    try {
      if (action === "merge") {
        setBusy(true);
        const { survivorId, absorbedId } = resolveMergeIds(pair, survivor);
        const keep = survivor === "a" ? pair.a : pair.b;
        const drop = survivor === "a" ? pair.b : pair.a;
        await submitMerge(survivorId, { absorbedId, reason: defaultMergeReason(keep, drop) }, fetcher);
      } else if (action === "split") {
        setBusy(true);
        const source = survivor === "a" ? pair.a : pair.b;
        await submitSplit(source.id, { evidenceIds: [], reason: defaultSplitReason(source) }, fetcher);
      }
      // keep_separate / not_duplicate は API を呼ばず、一覧からの除外のみ（最小実装）。
      onResolved(action, pair);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作に失敗しました");
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
          統合時に残す側（survivor）
        </legend>
        <label style={{ marginRight: 16, fontSize: 13 }}>
          <input
            type="radio"
            name={`survivor-${pairKey(pair)}`}
            checked={survivor === "a"}
            onChange={() => setSurvivor("a")}
          />{" "}
          {pair.a.displayId} を残す
        </label>
        <label style={{ fontSize: 13 }}>
          <input
            type="radio"
            name={`survivor-${pairKey(pair)}`}
            checked={survivor === "b"}
            onChange={() => setSurvivor("b")}
          />{" "}
          {pair.b.displayId} を残す
        </label>
      </fieldset>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="primary" disabled={busy} onClick={() => void run("merge")}>
          統合（Merge）
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void run("split")}>
          分割（Split）
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void run("keep_separate")}>
          別物として残す（Keep Separate）
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void run("not_duplicate")}>
          重複でない（Not Duplicate）
        </Button>
      </div>

      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13, marginTop: 8 }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
