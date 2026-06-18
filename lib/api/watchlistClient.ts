// task-37 — Watchlist UI 用の API クライアント（fetch ラッパ）。
//
// task-36 の Watchlist API（/api/watchlist, /api/watchlist/[id]）を叩く純関数群。
// 取得・作成・更新・削除・値更新（updateValue 導線）をここに集約し、UI 側（WatchlistView /
// 各ダイアログ）は状態とオーケストレーションだけを持つ。各関数は fetcher を DI 可能にして、
// DOM 依存を足さずに node テストで挙動（URL 組立・空文字の扱い・{ data } 取り出し）を検証する。
//
// 設計上の要点:
// - API は { data } / { error } の一貫形。!ok は失敗として throw（呼び出し側が握って表示する）。
// - linkedCandidateId は task-36 の検証層で空文字 "" が 400 になる（.min(1)）。そのため UI からは
//   「未指定（紐付けなし）」をフィールド省略で表す。空文字はボディに積まない（toWriteBody）。
//   ※ 既存紐付けの解除（disconnect）は現 API では空文字経路が 400 で塞がれており UI からは行えない
//     （candidate 削除時の SetNull でのみ解除される）。これは task-36 の仕様で本タスクの scope 外。
// - enum 文字列は直書きせず lib/validation/enums の値タプルを参照する。

import { WATCHLIST_ENTITY_TYPE_VALUES, type DeltaFlag } from "../validation/enums";

/** 一覧/詳細で受け取る Watchlist 1 件（API は日付を ISO 文字列で返す）。 */
export type WatchlistItem = {
  id: string;
  entityType: string;
  entityName: string;
  locale: string | null;
  metricName: string | null;
  lastValue: string | null;
  currentValue: string | null;
  deltaFlag: string;
  lastCheckedAt: string | null;
  linkedCandidateId: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 一覧フィルタ。entityType は空文字で「すべて」を表す（URL に積まない）。 */
export type WatchlistFilter = {
  entityType: string;
};

export function emptyWatchlistFilter(): WatchlistFilter {
  return { entityType: "" };
}

/** 新規作成 / 編集フォームの入力値（文字列で保持）。 */
export type WatchlistFormValues = {
  entityType: string;
  entityName: string;
  metricName: string;
  locale: string;
  linkedCandidateId: string;
  note: string;
};

export function emptyWatchlistForm(): WatchlistFormValues {
  return {
    entityType: WATCHLIST_ENTITY_TYPE_VALUES[0],
    entityName: "",
    metricName: "",
    locale: "",
    linkedCandidateId: "",
    note: "",
  };
}

/** 既存 Watchlist を編集フォームの初期値へ変換する（null は空文字に倒す）。 */
export function formValuesFromItem(item: WatchlistItem): WatchlistFormValues {
  return {
    entityType: item.entityType,
    entityName: item.entityName,
    metricName: item.metricName ?? "",
    locale: item.locale ?? "",
    linkedCandidateId: item.linkedCandidateId ?? "",
    note: item.note ?? "",
  };
}

/**
 * フォーム送信ボディを組み立てる。空文字の任意フィールド（metricName/locale/note）は省略する。
 * linkedCandidateId だけは三値の意味があるため特別扱いする:
 * - 非空 = その id を送る（connect）
 * - 空（「紐付けなし」選択）= 明示 null を送る（解除 disconnect / 未紐付け）
 * 空文字 "" は送らない（task-36 の .min(1) が 400 で弾くため）。これにより編集での紐付け解除が
 * PUT に end-to-end で乗る（省略すると「変更しない」と解釈され既存紐付けが残るバグだった。task-37）。
 */
export function toWriteBody(values: WatchlistFormValues): Record<string, string | null> {
  const body: Record<string, string | null> = {
    entityType: values.entityType,
    entityName: values.entityName.trim(),
  };
  const metricName = values.metricName.trim();
  if (metricName !== "") body.metricName = metricName;
  const locale = values.locale.trim();
  if (locale !== "") body.locale = locale;
  const linkedCandidateId = values.linkedCandidateId.trim();
  body.linkedCandidateId = linkedCandidateId !== "" ? linkedCandidateId : null;
  const note = values.note.trim();
  if (note !== "") body.note = note;
  return body;
}

/** 一覧取得 URL を組み立てる。entityType が空なら積まない。 */
export function buildWatchlistListUrl(filter: WatchlistFilter): string {
  const params = new URLSearchParams();
  if (filter.entityType) params.set("entityType", filter.entityType);
  const qs = params.toString();
  return qs ? `/api/watchlist?${qs}` : "/api/watchlist";
}

/** API 共通形 { data } を取り出す。!ok は失敗として throw（呼び出し側が握る）。 */
async function readData<T>(res: Response, failMessage: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${failMessage}（${res.status}）`);
  }
  const body = (await res.json()) as { data?: T };
  return body.data as T;
}

/** Watchlist 一覧を取得する。 */
export async function fetchWatchlist(
  filter: WatchlistFilter,
  fetcher: typeof fetch = fetch,
): Promise<WatchlistItem[]> {
  const res = await fetcher(buildWatchlistListUrl(filter), {
    headers: { Accept: "application/json" },
  });
  const data = await readData<WatchlistItem[]>(res, "Watchlist の取得に失敗しました");
  return data ?? [];
}

/** Watchlist を新規作成する（POST /api/watchlist）。 */
export async function createWatchlist(
  values: WatchlistFormValues,
  fetcher: typeof fetch = fetch,
): Promise<WatchlistItem> {
  const res = await fetcher("/api/watchlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toWriteBody(values)),
  });
  return readData<WatchlistItem>(res, "Watchlist の作成に失敗しました");
}

/** Watchlist を部分更新する（PUT /api/watchlist/[id]）。 */
export async function updateWatchlist(
  id: string,
  values: WatchlistFormValues,
  fetcher: typeof fetch = fetch,
): Promise<WatchlistItem> {
  const res = await fetcher(`/api/watchlist/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toWriteBody(values)),
  });
  return readData<WatchlistItem>(res, "Watchlist の更新に失敗しました");
}

/** Watchlist を削除する（DELETE /api/watchlist/[id]）。 */
export async function deleteWatchlist(id: string, fetcher: typeof fetch = fetch): Promise<void> {
  const res = await fetcher(`/api/watchlist/${id}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  await readData<unknown>(res, "Watchlist の削除に失敗しました");
}

/**
 * 今回値を記録する（PATCH /api/watchlist/[id] = updateValue 導線）。
 * current→last へシフトし deltaFlag を数値比較で再計算した最新の Watchlist を返す（§9.8）。
 */
export async function recordWatchlistValue(
  id: string,
  value: string,
  fetcher: typeof fetch = fetch,
): Promise<WatchlistItem> {
  const res = await fetcher(`/api/watchlist/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  return readData<WatchlistItem>(res, "今回値の記録に失敗しました");
}

/** 紐付け先 Candidate 選択用の最小オプション。 */
export type WatchlistCandidateOption = {
  id: string;
  displayId: string;
  title: string;
};

/**
 * 紐付け候補（Candidate）の一覧を取得する（GET /api/candidates）。
 * フォームの linkedCandidateId 選択と、行の紐付け表示（id→displayId/title）に使う。
 */
export async function fetchCandidateOptions(
  fetcher: typeof fetch = fetch,
): Promise<WatchlistCandidateOption[]> {
  const res = await fetcher("/api/candidates", { headers: { Accept: "application/json" } });
  const data = await readData<WatchlistCandidateOption[]>(res, "候補の取得に失敗しました");
  return data ?? [];
}

/** deltaFlag の表示表現（アイコン＋ラベル＋Badge tone）。色だけに依存しない（§9.8 / a11y）。 */
export type DeltaPresentation = {
  icon: string;
  label: string;
  /** Badge の tone。up=警告（競合上昇）/ down=情報 / unchanged=中立 / unknown=中立（薄字）。 */
  tone: "danger" | "info" | "neutral";
  /** unknown を薄字にするためのフラグ。 */
  muted: boolean;
};

/**
 * deltaFlag → 表示表現。
 * up=赤系（競合の上昇は警告）/ down=青系 / unchanged=グレー / unknown=薄字。
 * アイコンとテキストを必ず併記し、色だけに依存させない（アクセシビリティ）。
 */
export function deltaPresentation(flag: string): DeltaPresentation {
  switch (flag as DeltaFlag) {
    case "up":
      return { icon: "↑", label: "上昇", tone: "danger", muted: false };
    case "down":
      return { icon: "↓", label: "下降", tone: "info", muted: false };
    case "unchanged":
      return { icon: "→", label: "横ばい", tone: "neutral", muted: false };
    default:
      return { icon: "—", label: "不明", tone: "neutral", muted: true };
  }
}
