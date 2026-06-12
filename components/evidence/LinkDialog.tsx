"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { EVIDENCE_TYPE_VALUES } from "../../lib/validation/enums";
import { Badge, Button, Input, Modal, Select, type SelectOption } from "../ui";

// task-22 — Evidence link ダイアログ（spec v2 §9.6）。
// Evidence＝「RawSignal を Candidate に link する操作」を 2 導線で共通化したダイアログ。
// 独立 Evidence 作成画面は作らない（二重入力の排除）。
//
// 2 導線:
// - 导线A（RawSignal 起点・Inbox 側 / mode="candidate"）: 固定した RawSignal に対し、
//   候補を title / problemFamily でインクリメンタル検索 → 選択 → type/strength を付けて link。
// - 导线B（Candidate 起点・Candidate 詳細側 / mode="rawSignal"）: 固定した Candidate に対し、
//   未紐付け RawSignal（task-11 `?unlinked=1&q=`）を検索 → 選択 → type/strength を付けて link。
//
// どちらも最終的に POST /api/raw-signals/[rawSignalId]/link-candidate（task-12）を叩く。
// 成功時は API が対象 candidate の signalStats を返すので、呼び出し側が再取得して進級可否を
// 即時更新できる（§9.6）。二重 link は API が 409 を返す → UI にエラー表示する。
//
// テスト基盤に DOM/インタラクション依存は足さない方針のため、取得・送信・絞り込みのロジックは
// 純関数（fetcher DI）として切り出し、描画は react-dom/server の静的描画で確認する。
// enum 文字列は直書きせず task-02 の Zod 値タプル（EVIDENCE_TYPE_VALUES）から生成する。
//
// Out of scope（task doc）: 自由記述 Evidence 作成 / embedding サジェスト（Slice 4）。

/**
 * 最新リクエストだけを採用する連番ガード（stale response 対策）。
 * インクリメンタル検索はキー入力ごとに非同期取得するため、遅延差で古い結果が新しい結果を
 * 上書きし得る。連番トークンを発行し、応答到着時に最新でなければ破棄する（task-18〜21 と同一意図）。
 * React 非依存の純関数なので node テストで挙動を直接検証できる。
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

/** link の向き。"candidate"=导线A（候補を検索）, "rawSignal"=导线B（未紐付け RawSignal を検索）。 */
export type LinkMode = "candidate" | "rawSignal";

/** 导线A の検索結果（候補）。GET /api/candidates の data を表示に使う分だけ。 */
export type CandidateOption = {
  id: string;
  displayId: string;
  title: string;
  problemFamily: string | null;
};

/** 导线B の検索結果（未紐付け RawSignal）。GET /api/raw-signals?unlinked=1&q= の data の一部。 */
export type RawSignalOption = {
  id: string;
  displayId: string;
  sourceType: string;
  rawText: string;
  observedEntity: string | null;
};

/** link 成功時に API が返す signalStats（strongSignalTypes は JSON 化で配列）。§8.2 / §8.6。 */
export type LinkStats = {
  distinctSourceTypes: number;
  avgStrength: number;
  hasDirectSpend: boolean;
  strongSignalTypes: string[];
};

/** link 成功時の戻り（POST link-candidate の data: { evidence, stats }）。 */
export type LinkResult = {
  evidence: { id: string; evidenceType: string; strength: number; credibility: number };
  stats: LinkStats;
};

/** link の POST パラメータ。 */
export type LinkParams = {
  rawSignalId: string;
  candidateId: string;
  evidenceType: string;
  strength: number;
  credibility: number;
};

/** evidenceType コード → 表示ラベル（§7.4 の値域）。未知コードはそのまま使う。 */
export const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  spend: "支出（直接課金）",
  dissatisfaction: "不満・離脱",
  search: "検索需要",
  community: "コミュニティ言及",
  outsourcing: "外注・代行",
  job: "求人",
  regulation: "規制・制度",
  founder: "創業者観察",
};

/** evidenceType の選択肢。enum 値タプル（task-02）から生成する（文字列直書きしない）。 */
export const EVIDENCE_TYPE_OPTIONS: SelectOption[] = EVIDENCE_TYPE_VALUES.map((value) => ({
  value,
  label: EVIDENCE_TYPE_LABELS[value] ?? value,
}));

/** 0〜5 の素点選択肢（strength / credibility 共通。§8.1）。 */
export const SCORE_OPTIONS: SelectOption[] = [0, 1, 2, 3, 4, 5].map((n) => ({
  value: String(n),
  label: String(n),
}));

/** credibility の既定値（§9.6: 既定3）。 */
export const DEFAULT_CREDIBILITY = 3;
/** strength の既定値（未レビューでも過大評価しない中庸値）。 */
export const DEFAULT_STRENGTH = 3;

/** API 共通形 { data } を取り出す。!ok は失敗で throw（呼び出し側が握る）。 */
async function readData<T>(res: Response, failMessage: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${failMessage}（${res.status}）`);
  }
  const body = (await res.json()) as { data?: T };
  return body.data as T;
}

/**
 * 候補を q で client 側フィルタする（title / problemFamily の部分一致・大小無視）。
 * Candidate 一覧 API（task-13）は q 検索を持たない（repository.list に q が無い）ため、
 * 取得済みの一覧をここで絞り込む（API/リポジトリは本タスクの write scope 外）。単一ローカル
 * ユーザー前提で件数が小さいことを利用する（candidateRepo.list と同じ割り切り）。
 */
export function filterCandidates(items: CandidateOption[], q: string): CandidateOption[] {
  const needle = q.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter(
    (c) =>
      c.title.toLowerCase().includes(needle) ||
      (c.problemFamily ?? "").toLowerCase().includes(needle),
  );
}

/**
 * 导线A: 候補を取得し q でインクリメンタル絞り込みする。
 * Candidate 一覧 API は q 非対応のため、一覧を取得して filterCandidates で client 側絞り込みする。
 */
export async function searchCandidates(
  q: string,
  fetcher: typeof fetch = fetch,
): Promise<CandidateOption[]> {
  const res = await fetcher("/api/candidates", { headers: { Accept: "application/json" } });
  const data = await readData<CandidateOption[]>(res, "候補の取得に失敗しました");
  return filterCandidates(data ?? [], q);
}

/** 导线B: 未紐付け RawSignal を検索する URL（task-11 `?unlinked=1&q=`）。空 q は付けない。 */
export function unlinkedRawSignalsUrl(q: string): string {
  const params = new URLSearchParams({ unlinked: "1" });
  const trimmed = q.trim();
  if (trimmed !== "") params.set("q", trimmed);
  return `/api/raw-signals?${params.toString()}`;
}

/**
 * 导线B: 未紐付け RawSignal をサーバ側 q 検索で取得する（GET /api/raw-signals?unlinked=1&q=）。
 * unlinked=1 は repository 側で「status inbox かつ Evidence 0 件」に固定される（未紐付けの定義）。
 */
export async function searchUnlinkedRawSignals(
  q: string,
  fetcher: typeof fetch = fetch,
): Promise<RawSignalOption[]> {
  const res = await fetcher(unlinkedRawSignalsUrl(q), { headers: { Accept: "application/json" } });
  const data = await readData<RawSignalOption[]>(res, "Raw Signal の取得に失敗しました");
  return data ?? [];
}

/**
 * 固定エンティティ（mode）＋選択した相手から link の POST パラメータを組み立てる。
 * 导线A は rawSignalId 固定・candidateId=選択、导线B は candidateId 固定・rawSignalId=選択。
 */
export function buildLinkParams(opts: {
  rawSignalId?: string;
  candidateId?: string;
  selectedId: string;
  evidenceType: string;
  strength: number;
  credibility: number;
}): LinkParams {
  return {
    rawSignalId: opts.rawSignalId ?? opts.selectedId,
    candidateId: opts.candidateId ?? opts.selectedId,
    evidenceType: opts.evidenceType,
    strength: opts.strength,
    credibility: opts.credibility,
  };
}

/**
 * link を POST する（POST /api/raw-signals/[rawSignalId]/link-candidate、task-12）。
 * 二重 link は API が 409 を返す → 専用メッセージで throw し、UI にエラー表示させる（§9.6）。
 * 成功時は { evidence, stats } を返す（stats で呼び出し側が進級可否を即時更新できる）。
 */
export async function submitLink(
  params: LinkParams,
  fetcher: typeof fetch = fetch,
): Promise<LinkResult> {
  const { rawSignalId, candidateId, evidenceType, strength, credibility } = params;
  const res = await fetcher(`/api/raw-signals/${rawSignalId}/link-candidate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateId, evidenceType, strength, credibility }),
  });
  if (res.status === 409) {
    throw new Error("この証拠種別では既に紐付け済みです（二重 link はできません）");
  }
  if (!res.ok) {
    throw new Error(`紐付けに失敗しました（${res.status}）`);
  }
  const body = (await res.json()) as { data?: LinkResult };
  if (!body.data) {
    throw new Error("紐付けの応答が不正です");
  }
  return body.data;
}

const FIXED_BOX_STYLE = {
  border: "1px solid #eaecf0",
  borderRadius: 8,
  padding: "8px 12px",
  marginBottom: 12,
  fontSize: 13,
  background: "#f9fafb",
} as const;

const RESULT_LIST_STYLE = {
  listStyle: "none",
  margin: "8px 0 12px",
  padding: 0,
  maxHeight: 220,
  overflowY: "auto" as const,
  border: "1px solid #eaecf0",
  borderRadius: 8,
};

const RESULT_ITEM_BASE = {
  display: "block",
  width: "100%",
  textAlign: "left" as const,
  border: "none",
  borderBottom: "1px solid #eaecf0",
  background: "transparent",
  padding: "8px 12px",
  fontSize: 13,
  cursor: "pointer",
};

const FIELD_ROW_STYLE = { display: "flex", gap: 12, alignItems: "flex-end", marginTop: 8 } as const;
const FIELD_STYLE = { display: "flex", flexDirection: "column" as const, gap: 4, fontSize: 12 };

export type LinkDialogProps = {
  open: boolean;
  onClose: () => void;
  /** 导线A: 固定する RawSignal の id（指定時は候補を検索して link）。 */
  rawSignalId?: string;
  /** 导线A: 固定 RawSignal の表示ラベル（displayId 等）。 */
  rawSignalLabel?: string;
  /** 导线B: 固定する Candidate の id（指定時は未紐付け RawSignal を検索して link）。 */
  candidateId?: string;
  /** 导线B: 固定 Candidate の表示ラベル（displayId 等）。 */
  candidateLabel?: string;
  /** link 成功時のコールバック。呼び出し側が再取得して signalStats / キューを更新する。 */
  onLinked: (result: LinkResult) => void;
  /** テスト用の fetch 差し替え（既定は global fetch）。 */
  fetcher?: typeof fetch;
};

/**
 * Evidence link ダイアログ本体（共通）。rawSignalId / candidateId のどちらが渡るかで導線が決まる。
 * 検索（インクリメンタル）→ 選択 → type/strength/credibility 付与 → link を 1 つのモーダルで扱う。
 */
export function LinkDialog({
  open,
  onClose,
  rawSignalId,
  rawSignalLabel,
  candidateId,
  candidateLabel,
  onLinked,
  fetcher = fetch,
}: LinkDialogProps) {
  // rawSignalId が固定なら候補を検索（导线A）、そうでなければ未紐付け RawSignal を検索（导线B）。
  const mode: LinkMode = rawSignalId ? "candidate" : "rawSignal";

  const [query, setQuery] = useState("");
  const [candidateResults, setCandidateResults] = useState<CandidateOption[]>([]);
  const [rawResults, setRawResults] = useState<RawSignalOption[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [evidenceType, setEvidenceType] = useState("");
  const [strength, setStrength] = useState<number>(DEFAULT_STRENGTH);
  const [credibility, setCredibility] = useState<number>(DEFAULT_CREDIBILITY);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guardRef = useRef(createLatestGuard());

  // インクリメンタル検索。open 中に query が変わるたびに取得し、最新トークンだけ採用する。
  // 入力状態の初期化は「開くたびにフレッシュマウントする」ことで担保する（親が open 時のみ
  // 描画する）ため、reset effect は持たない。setState を effect 本体から外へ出すためタイマ経由で
  // 実行する（task-19〜21 と同じ流儀。cascading render 警告を避ける）。
  useEffect(() => {
    if (!open) return;
    const token = guardRef.current.next();
    const timer = setTimeout(() => {
      void (async () => {
        setSearching(true);
        try {
          if (mode === "candidate") {
            const found = await searchCandidates(query, fetcher);
            if (!guardRef.current.isCurrent(token)) return;
            setCandidateResults(found);
          } else {
            const found = await searchUnlinkedRawSignals(query, fetcher);
            if (!guardRef.current.isCurrent(token)) return;
            setRawResults(found);
          }
        } catch (e) {
          if (!guardRef.current.isCurrent(token)) return;
          setError(e instanceof Error ? e.message : "検索に失敗しました");
        } finally {
          if (guardRef.current.isCurrent(token)) setSearching(false);
        }
      })();
    }, 0);
    return () => clearTimeout(timer);
  }, [open, query, mode, fetcher]);

  const handleSubmit = useCallback(() => {
    if (submitting || selectedId === "" || evidenceType === "") return;
    setSubmitting(true);
    setError(null);
    void (async () => {
      try {
        const params = buildLinkParams({
          rawSignalId,
          candidateId,
          selectedId,
          evidenceType,
          strength,
          credibility,
        });
        const result = await submitLink(params, fetcher);
        onLinked(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : "紐付けに失敗しました");
      } finally {
        setSubmitting(false);
      }
    })();
  }, [
    submitting,
    selectedId,
    evidenceType,
    strength,
    credibility,
    rawSignalId,
    candidateId,
    onLinked,
    fetcher,
  ]);

  const canSubmit = selectedId !== "" && evidenceType !== "" && !submitting;
  const searchLabel =
    mode === "candidate" ? "候補を検索（title / 課題ファミリ）" : "未紐付け Raw Signal を検索";

  return (
    <Modal open={open} onClose={onClose} title="Evidence を link">
      {/* 固定エンティティ（どちらに link するか）を明示する。 */}
      <div style={FIXED_BOX_STYLE}>
        {mode === "candidate" ? (
          <span>
            Raw Signal <strong>{rawSignalLabel ?? rawSignalId}</strong> を候補に link します
          </span>
        ) : (
          <span>
            候補 <strong>{candidateLabel ?? candidateId}</strong> に Raw Signal を link します
          </span>
        )}
      </div>

      <label style={{ ...FIELD_STYLE, gap: 4 }}>
        <span style={{ color: "#667085" }}>{searchLabel}</span>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === "candidate" ? "請求書、経理 …" : "値上げ、解約 …"}
          aria-label={searchLabel}
        />
      </label>

      <ul style={RESULT_LIST_STYLE} aria-label="link 候補の検索結果">
        {mode === "candidate"
          ? candidateResults.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  style={{
                    ...RESULT_ITEM_BASE,
                    background: selectedId === c.id ? "#eef4ff" : "transparent",
                  }}
                  aria-pressed={selectedId === c.id}
                >
                  <span style={{ color: "#667085", marginRight: 8 }}>{c.displayId}</span>
                  <strong>{c.title}</strong>
                  {c.problemFamily ? (
                    <span style={{ color: "#667085", marginLeft: 8 }}>{c.problemFamily}</span>
                  ) : null}
                </button>
              </li>
            ))
          : rawResults.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  style={{
                    ...RESULT_ITEM_BASE,
                    background: selectedId === r.id ? "#eef4ff" : "transparent",
                  }}
                  aria-pressed={selectedId === r.id}
                >
                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ color: "#667085" }}>{r.displayId}</span>
                    <Badge tone="info">{r.sourceType}</Badge>
                    {r.observedEntity ? <span>対象: {r.observedEntity}</span> : null}
                  </span>
                  <span style={{ display: "block", marginTop: 4 }}>{r.rawText}</span>
                </button>
              </li>
            ))}
      </ul>
      {!searching &&
      (mode === "candidate" ? candidateResults.length === 0 : rawResults.length === 0) ? (
        <p style={{ color: "#667085", fontSize: 13, margin: "0 0 8px" }}>
          該当する{mode === "candidate" ? "候補" : "未紐付け Raw Signal"}はありません。
        </p>
      ) : null}

      {/* evidenceType / strength / credibility（§9.6: enum セレクト・素点 0-5・credibility 既定3）。 */}
      <div style={FIELD_ROW_STYLE}>
        <label style={FIELD_STYLE}>
          <span style={{ color: "#667085" }}>証拠種別</span>
          <Select
            options={EVIDENCE_TYPE_OPTIONS}
            placeholder="種別を選択"
            value={evidenceType}
            onChange={(e) => setEvidenceType(e.target.value)}
            aria-label="証拠種別"
          />
        </label>
        <label style={FIELD_STYLE}>
          <span style={{ color: "#667085" }}>強度</span>
          <Select
            options={SCORE_OPTIONS}
            value={String(strength)}
            onChange={(e) => setStrength(Number(e.target.value))}
            aria-label="強度"
          />
        </label>
        <label style={FIELD_STYLE}>
          <span style={{ color: "#667085" }}>信頼度</span>
          <Select
            options={SCORE_OPTIONS}
            value={String(credibility)}
            onChange={(e) => setCredibility(Number(e.target.value))}
            aria-label="信頼度"
          />
        </label>
      </div>

      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13, marginTop: 12 }}>
          {error}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          キャンセル
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
          {submitting ? "link 中…" : "link する"}
        </Button>
      </div>
    </Modal>
  );
}
