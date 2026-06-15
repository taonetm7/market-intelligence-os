"use client";

import { useCallback, useState } from "react";
import { useParams } from "next/navigation";

import { CandidateDetail } from "../../../components/candidate/CandidateDetail";
import { ExportButton } from "../../../components/candidate/ExportButton";
import { DetailedScorePanel } from "../../../components/candidate/DetailedScorePanel";
import { CandidateScoreMatrix } from "../../../components/candidate/ScoreConfidenceMatrix";
import { ScoreHistory } from "../../../components/candidate/ScoreHistory";
import { DecisionLogList } from "../../../components/candidate/DecisionLogList";
import { MergeSplitLauncher } from "../../../components/candidate/MergeSplitDialog";

// task-21 → task-31 — Candidate 詳細ページ（spec v2 §9.4 / §9.5）。
// 動的セグメント [id] を useParams（App Router の Client Component フック）で読み、task-21 の詳細
// 中核（CandidateDetail: 基本情報・Evidence・初期スコア・promote/reject）に、task-31 の v2 セクション
// （詳細スコア・2軸ビュー・スコア履歴・判断ログ・統合/分割）を積み増す。
//
// 各 v2 パネルは candidateId を受け取り自前で取得/操作する自己完結型（既存 UI の流儀）。詳細採点・
// 昇格・統合/分割といった「書き込み操作」が起きたら reload を +1 し、読み取り専用の3パネル
// （2軸ビュー・スコア履歴・判断ログ）へ伝播して取り直す（§9.5: 判断の文脈を割らず即時反映）。

const PANEL_STYLE = {
  border: "1px solid #eaecf0",
  borderRadius: 8,
  padding: 16,
  marginTop: 16,
} as const;

export default function CandidateDetailPage() {
  const params = useParams<{ id: string }>();
  // catch-all ではないため id は string。型安全のため string 以外は空にフォールバックする。
  const id = typeof params.id === "string" ? params.id : "";

  // 書き込み操作（詳細採点・昇格・統合/分割）が起きたら +1 し、読み取り専用パネルへ再取得を促す。
  const [reload, setReload] = useState(0);
  const bumpReload = useCallback(() => setReload((n) => n + 1), []);

  return (
    <>
      {/* task-21: 基本情報・Evidence・初期スコア・promote(top100)/reject。
          task-31: v2 書込（詳細採点・promote(top30)・統合/分割）後に reload を伝播し、本体の
          stage/score/Evidence も最新化する（§9.5: 判断の文脈を割らず即時反映）。 */}
      <CandidateDetail candidateId={id} reloadSignal={reload} />

      {id ? (
        <>
          {/* task-32: エクスポート（§10.2 Markdown / §10.3 Deep Research）。コピー / ダウンロード。
              読み取り専用の出力導線のため reload には依存しない（押下時に最新を取得する）。 */}
          <div style={PANEL_STYLE}>
            <ExportButton candidateId={id} />
          </div>

          {/* task-31: 詳細スコア（Top30 ゲート可否）＋ promote(top30)。 */}
          <div style={PANEL_STYLE}>
            <DetailedScorePanel candidateId={id} onChanged={bumpReload} />
          </div>

          {/* task-31: score × confidence 2軸ビュー（当該候補をプロット）。 */}
          <div style={PANEL_STYLE}>
            <CandidateScoreMatrix candidateId={id} reloadSignal={reload} />
          </div>

          {/* task-31: スコア履歴（ScoreSnapshot）。 */}
          <div style={PANEL_STYLE}>
            <ScoreHistory candidateId={id} reloadSignal={reload} />
          </div>

          {/* task-31: 判断ログ（DecisionLog）。 */}
          <div style={PANEL_STYLE}>
            <DecisionLogList candidateId={id} reloadSignal={reload} />
          </div>

          {/* task-31: 統合 / 分割（merge / split）。 */}
          <div style={PANEL_STYLE}>
            <MergeSplitLauncher candidateId={id} onChanged={bumpReload} />
          </div>
        </>
      ) : null}
    </>
  );
}
