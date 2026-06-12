"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { PageHeader } from "../layout/PageHeader";
import { Badge, Button } from "../ui";
import { LinkDialog } from "../evidence/LinkDialog";
import { formatConfidence, formatScore, stageTone } from "./CandidateTable";
import { ScoringPanel, type ScoreValues } from "./ScoringPanel";
import { RejectModal, promoteCandidate, rejectCandidate, type RejectInput } from "./PromoteRejectModal";

// task-21 — Candidate 詳細画面（spec v2 §9.5）。
// 候補の中核画面。基本情報・Evidence 一覧・Scoring パネル・進級/棄却を1画面に集約し、
// 「判断の文脈を割らない」（§9.5）。取得・操作のロジックは純関数（fetcher DI）に切り出し、
// 表示は state を持たないビューに分けて renderToStaticMarkup で検証する。state と
// オーケストレーション（操作 → 再取得）はこのコンポーネントが持つ（既存ページの流儀）。
//
// Out of scope（task doc）: 詳細スコア入力（task-26）/ ScoreSnapshot 履歴・DecisionLog 表示
//   （Slice 2）/ merge/split（task-28）。Evidence の「追加」は task-22 の link UI を起動する
//   フックのみ（本タスクでは導線＋TODO）。

/**
 * 最新リクエストだけを採用する連番ガード（stale response 対策）。
 * 操作のたびに候補・Evidence を取り直すため、遅延差で古い取得結果が新しい結果を上書きし得る。
 * 連番トークンを発行し、応答到着時に最新でなければ破棄する。task-19/20 と同一意図。
 * 共有ライブラリ化は本タスクの write scope 外のため局所定義する（React 非依存の純関数で
 * node テストから直接検証できる）。
 */
export function createLatestGuard() {
  let latest = 0;
  return {
    next(): number {
      latest += 1;
      return latest;
    },
    isCurrent(token: number): boolean {
      return token === latest;
    },
  };
}

/** 詳細表示に使う候補の形（GET /api/candidates/[id] の data。未採点フィールドは null）。 */
export type CandidateDetailData = {
  id: string;
  displayId: string;
  title: string;
  stage: string;
  problemFamily: string | null;
  targetUser: string | null;
  contextTrigger: string | null;
  painStatement: string | null;
  currentSubstitute: string | null;
  spendType: string | null;
  monetizationGuess: string | null;
  // §9.5 必須セクション。GET /api/candidates/[id] は productFormFit を string[] で返す
  // （candidateRepo.decode が *Json を復元）。本タスクは読み取り表示のみ。
  // TODO(task-26/編集フォーム): ProductFormFit の編集 UI は候補編集側の scope。
  productFormFit: string[];
  nextAction: string | null;
  initialScore: number | null;
  detailedScore: number | null;
  confidence: number | null;
  legalRisk: number | null;
  opsRisk: number | null;
  initialInputs: ScoreValues | null;
};

/** Evidence 一覧 1 行の形（GET /api/candidates/[id]/evidence の data）。 */
export type EvidenceRow = {
  id: string;
  evidenceType: string;
  strength: number;
  credibility: number;
  note: string | null;
  rawSignalId: string;
};

export function candidateEndpoint(id: string): string {
  return `/api/candidates/${id}`;
}
export function evidenceEndpoint(id: string): string {
  return `/api/candidates/${id}/evidence`;
}

/** 候補を 1 件取得する（GET /api/candidates/[id]）。404 は分かるメッセージで throw。 */
export async function fetchCandidate(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<CandidateDetailData> {
  const res = await fetcher(candidateEndpoint(id), { headers: { Accept: "application/json" } });
  if (res.status === 404) {
    throw new Error("候補が見つかりませんでした");
  }
  if (!res.ok) {
    throw new Error(`候補の取得に失敗しました（${res.status}）`);
  }
  const body = (await res.json()) as { data?: CandidateDetailData };
  if (!body.data) {
    throw new Error("候補の応答が不正です");
  }
  return body.data;
}

/** 候補に紐付く Evidence 一覧を取得する（GET /api/candidates/[id]/evidence）。 */
export async function fetchCandidateEvidence(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<EvidenceRow[]> {
  const res = await fetcher(evidenceEndpoint(id), { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Evidence の取得に失敗しました（${res.status}）`);
  }
  const body = (await res.json()) as { data?: EvidenceRow[] };
  return body.data ?? [];
}

/** 強シグナル（spend/dissatisfaction/search）は info で強調。それ以外は neutral。 */
const STRONG_EVIDENCE_TYPES = new Set(["spend", "dissatisfaction", "search"]);
export function evidenceTypeTone(type: string) {
  return STRONG_EVIDENCE_TYPES.has(type) ? ("info" as const) : ("neutral" as const);
}

/** ProductFormFit コード → 表示ラベル（spec v2 §6 productFormFitJson の値域）。 */
const PRODUCT_FORM_FIT_LABELS: Record<string, string> = {
  mobile_app: "モバイルアプリ",
  web_saas: "Web SaaS",
  ai_tool: "AI ツール",
  chrome_extension: "Chrome 拡張",
  template: "テンプレート",
  concierge: "コンシェルジュ",
};

/** ProductFormFit の string[] を表示文字列に整形する（未知コードはそのまま）。空配列は ""。 */
export function formatProductFormFit(codes: string[]): string {
  return codes.map((code) => PRODUCT_FORM_FIT_LABELS[code] ?? code).join("、");
}

const DEF_ROW_STYLE = { display: "flex", gap: 8, padding: "4px 0", fontSize: 13 } as const;
const DEF_LABEL_STYLE = { width: 140, color: "#667085", flexShrink: 0 } as const;

/** 基本情報の 1 行（値が空なら "—"）。 */
function DefRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={DEF_ROW_STYLE}>
      <span style={DEF_LABEL_STYLE}>{label}</span>
      <span>{value || "—"}</span>
    </div>
  );
}

export type CandidateSummaryProps = { candidate: CandidateDetailData };

/** 候補の基本情報（表示専用）。スコアと confidence を別行で併置する（§9.5）。 */
export function CandidateSummary({ candidate: c }: CandidateSummaryProps) {
  return (
    <section aria-label="候補の基本情報">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Badge tone={stageTone(c.stage)}>{c.stage}</Badge>
        <span style={{ color: "#667085", fontSize: 13 }}>{c.displayId}</span>
      </div>
      <DefRow label="課題ファミリ" value={c.problemFamily} />
      <DefRow label="対象ユーザー" value={c.targetUser} />
      <DefRow label="文脈・トリガー" value={c.contextTrigger} />
      <DefRow label="課題（Pain）" value={c.painStatement} />
      <DefRow label="現在の代替手段" value={c.currentSubstitute} />
      <DefRow label="支出形態" value={c.spendType} />
      <DefRow label="マネタイズ仮説" value={c.monetizationGuess} />
      <DefRow label="プロダクト形態" value={formatProductFormFit(c.productFormFit)} />
      <DefRow label="次アクション" value={c.nextAction} />
      <DefRow label="初期スコア" value={formatScore(c.initialScore)} />
      <DefRow label="詳細スコア" value={formatScore(c.detailedScore)} />
      <DefRow label="確信度" value={formatConfidence(c.confidence)} />
    </section>
  );
}

const EV_LIST_STYLE = { listStyle: "none", margin: 0, padding: 0 } as const;
const EV_ITEM_STYLE = {
  display: "flex",
  gap: 12,
  alignItems: "center",
  padding: "8px 0",
  borderBottom: "1px solid #eaecf0",
  fontSize: 13,
} as const;

export type EvidenceListProps = {
  evidences: EvidenceRow[];
  /** Evidence 追加（task-22 の link UI 起動）。本タスクでは導線フックのみ。 */
  onAddEvidence: () => void;
};

/**
 * Evidence 一覧（表示専用）。listByCandidate の結果を新しい順で並べる。
 * 「追加」は task-22 の link UI（候補に Raw Signal を link）を起動するフック。task-22 未実装の
 * ため、本タスクではボタン導線＋通知のみ（task-18 の Link プレースホルダと同じ流儀）。
 */
export function EvidenceList({ evidences, onAddEvidence }: EvidenceListProps) {
  return (
    <section aria-label="Evidence 一覧">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Evidence（{evidences.length}）</h2>
        {/* TODO(task-22): Evidence 追加は候補に Raw Signal を link する UI（link-candidate）を起動する。 */}
        <Button variant="ghost" onClick={onAddEvidence}>
          Evidence を追加
        </Button>
      </div>
      {evidences.length === 0 ? (
        <p style={{ color: "#667085", fontSize: 13 }}>
          紐付く Evidence はありません。「Evidence を追加」で Raw Signal を link します（task-22）。
        </p>
      ) : (
        <ul style={EV_LIST_STYLE}>
          {evidences.map((e) => (
            <li key={e.id} style={EV_ITEM_STYLE}>
              <Badge tone={evidenceTypeTone(e.evidenceType)}>{e.evidenceType}</Badge>
              <span>強度 {e.strength}</span>
              <span style={{ color: "#667085" }}>信頼度 {e.credibility}</span>
              {e.note ? <span>{e.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const PANEL_STYLE = {
  border: "1px solid #eaecf0",
  borderRadius: 8,
  padding: 16,
  marginTop: 16,
} as const;

export type CandidateDetailProps = { candidateId: string };

/**
 * Candidate 詳細画面本体。基本情報・Evidence 一覧・Scoring パネル・promote/reject を 1 画面に
 * 集約する。操作（promote / reject / 採点）のたびに候補と Evidence を取り直して反映する。
 */
export function CandidateDetail({ candidateId }: CandidateDetailProps) {
  const [candidate, setCandidate] = useState<CandidateDetailData | null>(null);
  const [evidences, setEvidences] = useState<EvidenceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  // Evidence link UI（task-22 导线B）の開閉。
  const [linkOpen, setLinkOpen] = useState(false);
  // link で signalStats が変わったことを ScoringPanel に伝える信号。+1 のたびに、採点済みなら
  // gate/confidence を同じ素点で再計算させ進級可否を即更新する（§9.5/§9.6）。
  const [scoringReload, setScoringReload] = useState(0);
  const guardRef = useRef(createLatestGuard());

  const load = useCallback(async () => {
    if (!candidateId) return;
    const token = guardRef.current.next();
    setLoading(true);
    setError(null);
    try {
      // 候補と Evidence を並行取得（候補取得が 404 等で throw すれば全体エラーにする）。
      const [c, ev] = await Promise.all([
        fetchCandidate(candidateId),
        fetchCandidateEvidence(candidateId),
      ]);
      if (!guardRef.current.isCurrent(token)) return;
      setCandidate(c);
      setEvidences(ev);
    } catch (e) {
      if (!guardRef.current.isCurrent(token)) return;
      setError(e instanceof Error ? e.message : "候補の取得に失敗しました");
      setCandidate(null);
      setEvidences([]);
    } finally {
      if (guardRef.current.isCurrent(token)) setLoading(false);
    }
  }, [candidateId]);

  // 初回マウントで取得する。setState を effect 本体から外へ出すためタイマ経由で実行する
  // （task-19/20 と同じ流儀。cascading render 警告を避ける）。
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  /** 操作（promote / reject）を実行 → 成功なら通知して候補・Evidence を取り直す。 */
  const runAction = useCallback(
    async (action: () => Promise<unknown>, successMessage: string) => {
      if (actionPending) return;
      setActionPending(true);
      setError(null);
      setNotice(null);
      try {
        await action();
        setNotice(successMessage);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "操作に失敗しました");
      } finally {
        setActionPending(false);
      }
    },
    [actionPending, load],
  );

  const handlePromote = useCallback(() => {
    void runAction(() => promoteCandidate(candidateId), "top100 へ昇格しました");
  }, [runAction, candidateId]);

  const handleRejectSubmit = useCallback(
    (input: RejectInput) => {
      setRejectOpen(false);
      void runAction(() => rejectCandidate(candidateId, input), "この候補を棄却しました");
    },
    [runAction, candidateId],
  );

  // Evidence 追加（task-22 导线B）: Candidate を固定し、未紐付け Raw Signal を検索して link する。
  const handleAddEvidence = useCallback(() => {
    setError(null);
    setNotice(null);
    setLinkOpen(true);
  }, []);

  // link 成功 → 通知して候補・Evidence を取り直す。さらに scoringReload を進め、採点済みなら
  // ScoringPanel に gate/confidence を再計算させて進級可否を即更新する（§9.5/§9.6）。
  const handleLinked = useCallback(() => {
    setLinkOpen(false);
    setNotice("Raw Signal を Evidence として link しました");
    void load();
    setScoringReload((n) => n + 1);
  }, [load]);

  // 採点（保存して計算・link 後の再計算）成功時に候補を取り直し、stage/score/confidence を反映する。
  // ScoringPanel の reloadSignal 再計算が安定して走るよう、参照を固定する（load は安定）。
  const handleScored = useCallback(() => void load(), [load]);

  // 昇格できるのは normalized の候補のみ（§8.9。Slice 1 は normalized→top100）。
  const canPromote = candidate?.stage === "normalized";
  // 棄却済み/退役済みは再棄却しない。
  const canReject =
    candidate !== null && candidate.stage !== "rejected" && candidate.stage !== "archived";

  return (
    <>
      <PageHeader
        title={candidate ? candidate.title : "Candidate"}
        description="候補の基本情報・Evidence・スコアリング・進級/棄却を1画面で扱います（§9.5）。"
        actions={
          candidate ? (
            <div style={{ display: "flex", gap: 8 }}>
              <Button
                variant="primary"
                onClick={handlePromote}
                disabled={!canPromote || actionPending}
              >
                promote（top100 へ）
              </Button>
              <Button
                variant="danger"
                onClick={() => setRejectOpen(true)}
                disabled={!canReject || actionPending}
              >
                reject（棄却）
              </Button>
            </div>
          ) : null
        }
      />

      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13 }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" style={{ color: "#1a7f3c", fontSize: 13 }}>
          {notice}
        </p>
      ) : null}

      {candidate === null ? (
        <p style={{ color: "#667085", fontSize: 13 }}>
          {loading ? "読み込み中…" : error ? "" : "候補がありません"}
        </p>
      ) : (
        <>
          <CandidateSummary candidate={candidate} />

          <div style={PANEL_STYLE}>
            <EvidenceList evidences={evidences} onAddEvidence={handleAddEvidence} />
          </div>

          <div style={PANEL_STYLE}>
            <ScoringPanel
              candidateId={candidate.id}
              initialValues={candidate.initialInputs ?? undefined}
              onScored={handleScored}
              reloadSignal={scoringReload}
            />
          </div>
        </>
      )}

      <RejectModal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onSubmit={handleRejectSubmit}
        submitting={actionPending}
      />

      {/* Evidence link UI（导线B）: Candidate を固定し未紐付け Raw Signal を検索して link する。
          開いている間だけ描画し、開くたびにフレッシュマウントして入力状態を初期化する。 */}
      {linkOpen ? (
        <LinkDialog
          open
          onClose={() => setLinkOpen(false)}
          candidateId={candidateId}
          candidateLabel={candidate?.displayId}
          onLinked={handleLinked}
        />
      ) : null}
    </>
  );
}
