import { Input, Select, type SelectOption } from "../ui";
import { SOURCE_TYPE_VALUES, STATUS_VALUES } from "../../lib/validation/enums";
import type { RawSignalRow } from "./RawSignalTable";

// task-19 — Raw Signal 一覧のフィルタ（spec v2 §9.3）。
// フィルタ: sourceType / status / 未紐付け / タグ ＋ 全文検索 q。
//
// sourceType / status / unlinked / q は task-11 の GET /api/raw-signals の
// クエリパラメータへマップする（サーバ側で絞り込む）。タグは repository.list が
// 受け付けないため（repo の API は変更しない方針）、取得後にクライアント側で
// 適用する。これらの組立・取得ロジックは純関数に切り出し、依存追加なしの
// node テストで受入基準（フィルタが API クエリへ反映される）を直接検証する。

/** フィルタの状態（すべて文字列 / boolean、空 = 未指定）。 */
export type RawSignalQuery = {
  sourceType: string;
  status: string;
  /** クライアント側で signalTags に対して contains 絞り込み（サーバ非対応）。 */
  tag: string;
  unlinkedOnly: boolean;
  q: string;
};

export function emptyRawSignalQuery(): RawSignalQuery {
  return { sourceType: "", status: "", tag: "", unlinkedOnly: false, q: "" };
}

// 先頭に「すべて（値なし）」を置く（Select の placeholder は disabled で選び直せないため、
// クリア用の空 option を通常選択肢として用意する）。
export const SOURCE_TYPE_FILTER_OPTIONS: SelectOption[] = [
  { value: "", label: "すべてのソース種別" },
  ...SOURCE_TYPE_VALUES.map((v) => ({ value: v, label: v })),
];
export const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: "", label: "すべてのステータス" },
  ...STATUS_VALUES.map((v) => ({ value: v, label: v })),
];

/**
 * クエリ状態を GET /api/raw-signals の URL へ組み立てる（サーバ側フィルタのみ）。
 * 空のパラメータは送らない。tag はサーバ非対応のため URL に含めない。
 */
export function buildRawSignalListUrl(query: RawSignalQuery): string {
  const params = new URLSearchParams();
  if (query.sourceType) params.set("sourceType", query.sourceType);
  if (query.status) params.set("status", query.status);
  if (query.unlinkedOnly) params.set("unlinked", "1");
  const q = query.q.trim();
  if (q) params.set("q", q);
  const qs = params.toString();
  return qs ? `/api/raw-signals?${qs}` : "/api/raw-signals";
}

/** signalTags に対する contains 絞り込み（大文字小文字を無視）。空タグは素通し。 */
export function applyTagFilter(rows: RawSignalRow[], tag: string): RawSignalRow[] {
  const needle = tag.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => row.signalTags.some((t) => t.toLowerCase().includes(needle)));
}

/**
 * 一覧を取得する。fetcher は DI 可能（テストで差し替える）。
 * サーバ側フィルタで取得 → tag はクライアント側で適用して返す。
 */
export async function fetchRawSignals(
  query: RawSignalQuery,
  fetcher: typeof fetch = fetch,
): Promise<RawSignalRow[]> {
  const res = await fetcher(buildRawSignalListUrl(query), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`一覧の取得に失敗しました（${res.status}）`);
  }
  const body = (await res.json()) as { data?: RawSignalRow[] };
  return applyTagFilter(body.data ?? [], query.tag);
}

const FIELD_STYLE = { display: "flex", flexDirection: "column", gap: 4, fontSize: 13 } as const;
const LABEL_STYLE = { fontWeight: 600 } as const;

export type RawSignalFiltersProps = {
  value: RawSignalQuery;
  onChange: (next: RawSignalQuery) => void;
};

/** フィルタ UI（controlled）。各操作は onChange で親へ反映する。 */
export function RawSignalFilters({ value, onChange }: RawSignalFiltersProps) {
  function set<K extends keyof RawSignalQuery>(key: K, v: RawSignalQuery[K]) {
    onChange({ ...value, [key]: v });
  }

  return (
    <div
      role="search"
      aria-label="Raw Signal フィルタ"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-end",
        gap: 12,
        marginBottom: 16,
      }}
    >
      <label style={{ ...FIELD_STYLE, minWidth: 220, flex: 1 }}>
        <span style={LABEL_STYLE}>検索</span>
        <Input
          type="search"
          value={value.q}
          onChange={(e) => set("q", e.target.value)}
          placeholder="本文・観測対象・ソース名・メモ"
        />
      </label>

      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>ソース種別</span>
        <Select
          options={SOURCE_TYPE_FILTER_OPTIONS}
          value={value.sourceType}
          onChange={(e) => set("sourceType", e.target.value)}
        />
      </label>

      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>ステータス</span>
        <Select
          options={STATUS_FILTER_OPTIONS}
          value={value.status}
          onChange={(e) => set("status", e.target.value)}
        />
      </label>

      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>タグ</span>
        <Input
          value={value.tag}
          onChange={(e) => set("tag", e.target.value)}
          placeholder="タグで絞り込み"
        />
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={value.unlinkedOnly}
          onChange={(e) => set("unlinkedOnly", e.target.checked)}
        />
        <span style={LABEL_STYLE}>未紐付けのみ</span>
      </label>
    </div>
  );
}
