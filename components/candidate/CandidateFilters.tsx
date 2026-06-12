import { Input, Select, type SelectOption } from "../ui";
import { STAGE_VALUES } from "../../lib/validation/enums";
import type { CandidateRow } from "./CandidateTable";

// task-20 — Candidate 一覧のフィルタ（spec v2 §9.4）。
// フィルタ: ビュー（すべて / Top100）/ stage / Evidence 数（下限）/ リスク上限 /
//   ProductFormFit ＋ 並び替え（ユーザー選択式）。
//
// サーバ側で絞り込めるもの（stage / minEvidence / sortBy）は task-13 の
// GET /api/candidates のクエリへマップする。Top100 ビューは task-13 の
// GET /api/candidates/top100（ゲート判定 API）を使う固定ビュー。
// リスク・ProductFormFit は repository.list が受け付けない（repo の API は
// 変更しない方針）ため、取得後にクライアント側で適用する。これらの組立・取得・
// 絞り込みロジックは純関数に切り出し、依存追加なしの node テストで受入基準を検証する。
//
// 既定ソートはスコア単独にしない（§9.4 過信防止）。既定は updatedAt（DEFAULT_SORT_BY）。
// スコア軸（initialScore / detailedScore）は明示選択時のみ採用する。

export type CandidateView = "all" | "top100";

/** フィルタの状態（数値も入力中は文字列で保持。空 = 未指定）。 */
export type CandidateQuery = {
  view: CandidateView;
  stage: string;
  /** Evidence 件数の下限（サーバ minEvidence）。 */
  minEvidence: string;
  /** legalRisk / opsRisk の上限（クライアント側で適用。空 = 上限なし）。 */
  maxRisk: string;
  /** ProductFormFit の contains 絞り込み（クライアント側。サーバ非対応）。 */
  productFormFit: string;
  /** 並び替え軸。既定は updatedAt（スコア単独にしない）。 */
  sortBy: string;
};

/**
 * 既定の並び替え軸。スコア単独にしない（§9.4 過信防止）ため updatedAt とする。
 * 値は task-13 candidateRepo の CANDIDATE_SORT_BY_VALUES に対応（妥当性はサーバの
 * Zod が検証する）。server 専用モジュール（Prisma 依存）を client から import しない
 * ため、UI 側ではここに文字列で定義する。
 */
export const DEFAULT_SORT_BY = "updatedAt";

/** スコア単独の並び替え軸（既定にしてはいけない集合）。テストで既定の除外を担保する。 */
export const SCORE_ONLY_SORT_KEYS = ["initialScore", "detailedScore"] as const;

export function emptyCandidateQuery(): CandidateQuery {
  return {
    view: "all",
    stage: "",
    minEvidence: "",
    maxRisk: "",
    productFormFit: "",
    sortBy: DEFAULT_SORT_BY,
  };
}

export const VIEW_OPTIONS: SelectOption[] = [
  { value: "all", label: "すべて" },
  { value: "top100", label: "Top100（ゲート通過）" },
];

// 先頭に「すべて（値なし）」を置く（クリア用の空 option）。
export const STAGE_FILTER_OPTIONS: SelectOption[] = [
  { value: "", label: "すべての stage" },
  ...STAGE_VALUES.map((v) => ({ value: v, label: v })),
];

export const RISK_FILTER_OPTIONS: SelectOption[] = [
  { value: "", label: "リスク上限なし" },
  { value: "1", label: "リスク ≤ 1" },
  { value: "2", label: "リスク ≤ 2" },
  { value: "3", label: "リスク ≤ 3" },
];

// 並び替えの選択肢。先頭（既定）はスコア単独でない updatedAt（§9.4 過信防止）。
export const SORT_BY_OPTIONS: SelectOption[] = [
  { value: "updatedAt", label: "更新日（新しい順）" },
  { value: "createdAt", label: "作成日（新しい順）" },
  { value: "confidence", label: "確信度" },
  { value: "evidenceCount", label: "Evidence 数" },
  { value: "initialScore", label: "初期スコア" },
  { value: "detailedScore", label: "詳細スコア" },
];

/** Top100 ゲート判定 API（task-13）。固定ビューでサーバパラメータは取らない。 */
export const TOP100_ENDPOINT = "/api/candidates/top100";

/**
 * クエリ状態を取得 URL へ組み立てる。
 * Top100 ビューはゲート判定 API（パラメータなし）。それ以外は GET /api/candidates へ
 * stage / minEvidence / sortBy を積む（空は送らない）。リスク・ProductFormFit は
 * サーバ非対応のため URL に含めない（クライアント側で適用）。
 */
export function buildCandidateListUrl(query: CandidateQuery): string {
  if (query.view === "top100") return TOP100_ENDPOINT;

  const params = new URLSearchParams();
  if (query.stage) params.set("stage", query.stage);
  // 既定 updatedAt を含め常に明示送信する（サーバ既定 createdAt との差を意図的に上書き）。
  if (query.sortBy) params.set("sortBy", query.sortBy);
  const min = query.minEvidence.trim();
  if (min && Number.isFinite(Number(min))) params.set("minEvidence", min);
  const qs = params.toString();
  return qs ? `/api/candidates?${qs}` : "/api/candidates";
}

/**
 * リスク上限フィルタ（legalRisk / opsRisk の最大が上限以下）。空・非数は素通し。
 * 欠損（null）は 0 とみなす（リスク情報なし＝低リスク側に倒す）。
 */
export function applyRiskFilter<T extends { legalRisk: number | null; opsRisk: number | null }>(
  rows: T[],
  maxRisk: string,
): T[] {
  const raw = maxRisk.trim();
  if (!raw) return rows;
  const limit = Number(raw);
  if (!Number.isFinite(limit)) return rows;
  return rows.filter((r) => Math.max(r.legalRisk ?? 0, r.opsRisk ?? 0) <= limit);
}

/** ProductFormFit の contains 絞り込み（大文字小文字を無視）。空タグは素通し。 */
export function applyProductFormFitFilter<T extends { productFormFit: string[] }>(
  rows: T[],
  needle: string,
): T[] {
  const q = needle.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.productFormFit.some((f) => f.toLowerCase().includes(q)));
}

/**
 * API が返す 1 行。表示用 CandidateRow に加え、クライアント側フィルタ
 * （リスク / ProductFormFit）に必要な素点・配列も持つ（CandidateListItem の部分集合）。
 */
export type FetchedCandidate = CandidateRow & {
  legalRisk: number | null;
  opsRisk: number | null;
  productFormFit: string[];
};

/**
 * 一覧を取得する。fetcher は DI 可能（テストで差し替える）。
 * サーバ側フィルタで取得 → リスク・ProductFormFit はクライアント側で適用して返す。
 */
export async function fetchCandidates(
  query: CandidateQuery,
  fetcher: typeof fetch = fetch,
): Promise<FetchedCandidate[]> {
  const res = await fetcher(buildCandidateListUrl(query), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`一覧の取得に失敗しました（${res.status}）`);
  }
  const body = (await res.json()) as { data?: FetchedCandidate[] };
  let rows = body.data ?? [];
  rows = applyRiskFilter(rows, query.maxRisk);
  rows = applyProductFormFitFilter(rows, query.productFormFit);
  return rows;
}

const FIELD_STYLE = { display: "flex", flexDirection: "column", gap: 4, fontSize: 13 } as const;
const LABEL_STYLE = { fontWeight: 600 } as const;

export type CandidateFiltersProps = {
  value: CandidateQuery;
  onChange: (next: CandidateQuery) => void;
};

/** フィルタ UI（controlled）。各操作は onChange で親へ反映する。 */
export function CandidateFilters({ value, onChange }: CandidateFiltersProps) {
  function set<K extends keyof CandidateQuery>(key: K, v: CandidateQuery[K]) {
    onChange({ ...value, [key]: v });
  }
  // Top100 はゲート判定 API の固定ビューなので、サーバ側で効く stage / Evidence 数 /
  // 並び替えは無効化する（リスク・ProductFormFit はクライアント側なので有効のまま）。
  const isTop100 = value.view === "top100";

  return (
    <div
      role="search"
      aria-label="Candidate フィルタ"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-end",
        gap: 12,
        marginBottom: 16,
      }}
    >
      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>ビュー</span>
        <Select
          options={VIEW_OPTIONS}
          value={value.view}
          onChange={(e) => set("view", e.target.value as CandidateView)}
        />
      </label>

      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>stage</span>
        <Select
          options={STAGE_FILTER_OPTIONS}
          value={value.stage}
          onChange={(e) => set("stage", e.target.value)}
          disabled={isTop100}
        />
      </label>

      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>Evidence 数（下限）</span>
        <Input
          type="number"
          min={0}
          value={value.minEvidence}
          onChange={(e) => set("minEvidence", e.target.value)}
          placeholder="0"
          disabled={isTop100}
        />
      </label>

      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>リスク上限</span>
        <Select
          options={RISK_FILTER_OPTIONS}
          value={value.maxRisk}
          onChange={(e) => set("maxRisk", e.target.value)}
        />
      </label>

      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>ProductFormFit</span>
        <Input
          value={value.productFormFit}
          onChange={(e) => set("productFormFit", e.target.value)}
          placeholder="形態で絞り込み"
        />
      </label>

      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>並び替え</span>
        <Select
          options={SORT_BY_OPTIONS}
          value={value.sortBy}
          onChange={(e) => set("sortBy", e.target.value)}
          disabled={isTop100}
        />
      </label>
    </div>
  );
}
