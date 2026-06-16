"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PageHeader } from "../../components/layout/PageHeader";
import { Button, Select, type SelectOption } from "../../components/ui";
import { WatchlistRow } from "../../components/watchlist/WatchlistRow";
import { ENTITY_TYPE_OPTIONS, WatchlistFormDialog } from "../../components/watchlist/WatchlistFormDialog";
import { UpdateValueDialog } from "../../components/watchlist/UpdateValueDialog";
import {
  createWatchlist,
  deleteWatchlist,
  emptyWatchlistFilter,
  fetchCandidateOptions,
  fetchWatchlist,
  formValuesFromItem,
  recordWatchlistValue,
  updateWatchlist,
  type WatchlistCandidateOption,
  type WatchlistFilter,
  type WatchlistFormValues,
  type WatchlistItem,
} from "../../lib/api/watchlistClient";

// task-37 — Watchlist UI のクライアント本体（spec v2 §9.8）。
// 一覧（entityType フィルタ）・新規作成/編集・削除・「今回値を記録」（updateValue 導線）を
// task-36 の API 経由で行う。取得・送信ロジックは lib/api/watchlistClient（fetcher DI・node テスト
// 可能）に切り出し、ここは状態とオーケストレーション（操作 → 再取得）だけを持つ。

/**
 * 最新リクエストだけを採用する連番ガード（stale response 対策）。
 * フィルタ変更・操作後の再取得で、遅延差により古い応答が新しい応答を上書きし得る。
 * 連番トークンを発行し、応答到着時に最新でなければ破棄する（task-18〜22 と同一意図）。
 * 共有ライブラリ化は scope 外のため局所定義する。React 非依存なので node テストで直接検証できる。
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

/** entityType フィルタの選択肢（先頭に「すべて」）。 */
export const ENTITY_TYPE_FILTER_OPTIONS: SelectOption[] = [
  { value: "", label: "すべての種別" },
  ...ENTITY_TYPE_OPTIONS,
];

export function WatchlistView() {
  const [filter, setFilter] = useState<WatchlistFilter>(emptyWatchlistFilter());
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [candidates, setCandidates] = useState<WatchlistCandidateOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  // ダイアログ状態: フォーム（新規 or 編集対象）・今回値記録（対象 item）。
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<WatchlistItem | null>(null);
  const [valueTarget, setValueTarget] = useState<WatchlistItem | null>(null);

  const guardRef = useRef(createLatestGuard());

  const load = useCallback(async (f: WatchlistFilter) => {
    const token = guardRef.current.next();
    setLoading(true);
    setError(null);
    try {
      const result = await fetchWatchlist(f);
      if (!guardRef.current.isCurrent(token)) return;
      setItems(result);
    } catch (e) {
      if (!guardRef.current.isCurrent(token)) return;
      setError(e instanceof Error ? e.message : "Watchlist の取得に失敗しました");
      setItems([]);
    } finally {
      if (guardRef.current.isCurrent(token)) setLoading(false);
    }
  }, []);

  // フィルタ変更のたびに取得し直す（setState を effect 本体から外すためタイマ経由）。
  useEffect(() => {
    const timer = setTimeout(() => void load(filter), 0);
    return () => clearTimeout(timer);
  }, [filter, load]);

  // 紐付け候補は初回に 1 度だけ取得する（フォーム選択肢・行の紐付け表示に使う）。
  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          setCandidates(await fetchCandidateOptions());
        } catch {
          // 候補取得の失敗は致命ではない（id 表示にフォールバックする）。
        }
      })();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  /** id → 候補オプション（行の紐付け表示用）。 */
  const candidateById = useMemo(() => {
    const map = new Map<string, WatchlistCandidateOption>();
    for (const c of candidates) map.set(c.id, c);
    return map;
  }, [candidates]);

  const openCreate = useCallback(() => {
    setEditing(null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((item: WatchlistItem) => {
    setEditing(item);
    setFormOpen(true);
  }, []);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditing(null);
  }, []);

  // 新規作成 or 更新（editing の有無で分岐）。成功 → 閉じて通知・再取得。
  const handleFormSubmit = useCallback(
    async (values: WatchlistFormValues) => {
      setError(null);
      setNotice(null);
      if (editing) {
        await updateWatchlist(editing.id, values);
        setNotice(`${values.entityName} を更新しました`);
      } else {
        await createWatchlist(values);
        setNotice(`${values.entityName} を追加しました`);
      }
      closeForm();
      await load(filter);
    },
    [editing, closeForm, load, filter],
  );

  // 今回値の記録（updateValue 導线）。成功 → 閉じて通知・再取得（last/current/delta が反映される）。
  const handleRecordValue = useCallback(
    async (item: WatchlistItem, value: string) => {
      setError(null);
      setNotice(null);
      await recordWatchlistValue(item.id, value);
      setValueTarget(null);
      setNotice(`${item.entityName} の今回値を記録しました`);
      await load(filter);
    },
    [load, filter],
  );

  // 削除（確認 → DELETE）。多重送信防止に pendingId を立てる。
  const handleDelete = useCallback(
    (item: WatchlistItem) => {
      if (pendingId) return;
      if (typeof window !== "undefined" && !window.confirm(`${item.entityName} を削除しますか？`)) {
        return;
      }
      setPendingId(item.id);
      setError(null);
      setNotice(null);
      void (async () => {
        try {
          await deleteWatchlist(item.id);
          setNotice(`${item.entityName} を削除しました`);
          await load(filter);
        } catch (e) {
          setError(e instanceof Error ? e.message : "削除に失敗しました");
        } finally {
          setPendingId(null);
        }
      })();
    },
    [pendingId, load, filter],
  );

  return (
    <>
      <PageHeader
        title="Watchlist"
        description="競合アプリ・キーワード・ランキング等の定点観測。前回値→今回値→差分を手動で記録します。"
      />

      <div
        role="search"
        aria-label="Watchlist フィルタ"
        style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 16 }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>種別</span>
          <Select
            options={ENTITY_TYPE_FILTER_OPTIONS}
            value={filter.entityType}
            onChange={(e) => setFilter({ ...filter, entityType: e.target.value })}
            aria-label="種別フィルタ"
          />
        </label>
        <Button variant="primary" onClick={openCreate}>
          Watchlist を追加
        </Button>
        <Button variant="ghost" onClick={() => void load(filter)} disabled={loading}>
          {loading ? "更新中…" : "再読み込み"}
        </Button>
      </div>

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

      <table className="mi-table" aria-label="Watchlist 一覧">
        <thead>
          <tr>
            <th>対象</th>
            <th>指標</th>
            <th>前回値 → 今回値</th>
            <th>差分</th>
            <th>最終確認</th>
            <th>紐付け候補</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td className="mi-table__empty" colSpan={7}>
                {loading ? "読み込み中…" : "Watchlist がありません"}
              </td>
            </tr>
          ) : (
            items.map((item) => (
              <WatchlistRow
                key={item.id}
                item={item}
                candidate={
                  item.linkedCandidateId
                    ? candidateById.get(item.linkedCandidateId)
                    : undefined
                }
                onRecordValue={setValueTarget}
                onEdit={openEdit}
                onDelete={handleDelete}
                pending={pendingId === item.id}
              />
            ))
          )}
        </tbody>
      </table>

      {/* 新規作成 / 編集（開く間だけ描画してフレッシュマウントさせる）。 */}
      {formOpen ? (
        <WatchlistFormDialog
          open
          initial={editing ? formValuesFromItem(editing) : undefined}
          candidates={candidates}
          onClose={closeForm}
          onSubmit={handleFormSubmit}
        />
      ) : null}

      {/* 今回値の記録（updateValue 導線）。対象ごとに key で入力状態をリセットする。 */}
      {valueTarget ? (
        <UpdateValueDialog
          key={valueTarget.id}
          item={valueTarget}
          onClose={() => setValueTarget(null)}
          onSubmit={handleRecordValue}
        />
      ) : null}
    </>
  );
}
