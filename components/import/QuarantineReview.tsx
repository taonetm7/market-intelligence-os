"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Badge, Button, Modal, Table, type Column } from "../ui";

// task-23 — Quarantine レビュー（valid/invalid 表示・行選択・accept）。spec v2 §10.1 / §11.2。
// import で投入された隔離行（QuarantineRow）を batch 単位で確認し、人間が選択して accept した
// 行だけを RawSignal へ本登録する。invalid 行は行番号＋Zod 理由を表示し accept 対象外（§10.1：
// 失敗行は本登録できない）。accept 前に「N 件を本登録します」を確認する（task-15 の auto-snapshot
// と整合）。自動 accept は禁止（必ず人間・task doc Out of scope）。
//
// API（task-15）:
// - GET  /api/imports/quarantine?batchId=  → { data: [{ batch, pending, invalid, accepted }] }
// - POST /api/imports/[batchId]/accept     → { data: { accepted, snapshot } }（409=invalid/再accept）
//
// テスト基盤に DOM / インタラクション依存は足さない方針のため、取得・accept・選択・整形の各
// ロジックを純関数として切り出し、描画は presentational な QuarantinePanel を react-dom/server の
// 静的描画で確認する（状態・effect は QuarantineReview 側に閉じる）。

/**
 * 最新リクエストだけを採用する連番ガード（stale response 対策）。
 * accept 後に再取得するため、遅延差で古い取得結果が新しい結果を上書きし得る。連番トークンを
 * 発行し、応答到着時に最新でなければ破棄する（task-18〜22 と同一意図）。共有ライブラリ化は本
 * タスクの write scope 外のため局所定義する。React 非依存の純関数なので node テストで検証できる。
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

/** 隔離行（QuarantineRow）の表示に使う分。payloadJson / errorsJson は直列化文字列。 */
export type QuarantineRowView = {
  id: string;
  rowNumber: number;
  status: string; // pending | invalid | accepted
  payloadJson: string | null;
  errorsJson: string | null;
  rawSignalId: string | null;
};

/** import バッチ（ImportBatch）の表示に使う分。 */
export type ImportBatchView = {
  id: string;
  origin: string;
  format: string;
  note: string | null;
  createdAt: string;
};

/** 1 バッチ分の隔離一覧（status 別に束ねたもの）。 */
export type QuarantineBatchView = {
  batch: ImportBatchView;
  pending: QuarantineRowView[];
  invalid: QuarantineRowView[];
  accepted: QuarantineRowView[];
};

/** accept の結果（行数と auto-snapshot 件数記録）。 */
export type AcceptOutcome = {
  acceptedCount: number;
  snapshot: {
    rawSignalCountBefore: number;
    acceptedCount: number;
    rawSignalCountAfter: number;
  };
};

/** quarantine 一覧 API（task-15）。 */
export const QUARANTINE_URL = "/api/imports/quarantine";

/** batchId 指定の quarantine 取得 URL（未指定なら全バッチ）。 */
export function quarantineUrl(batchId?: string): string {
  if (!batchId) return QUARANTINE_URL;
  return `${QUARANTINE_URL}?batchId=${encodeURIComponent(batchId)}`;
}

/** accept API（task-15）の URL。 */
export function acceptUrl(batchId: string): string {
  return `/api/imports/${encodeURIComponent(batchId)}/accept`;
}

/** API 共通形 { data } を取り出す。!ok は失敗で throw。 */
async function readData<T>(res: Response, failMessage: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${failMessage}（${res.status}）`);
  }
  const body = (await res.json()) as { data?: T };
  return body.data as T;
}

/**
 * 隔離一覧を取得する（GET /api/imports/quarantine?batchId=）。batchId 指定時はそのバッチのみ。
 * batch 単位で pending / invalid / accepted を束ねた配列を返す。
 */
export async function fetchQuarantine(
  batchId: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<QuarantineBatchView[]> {
  const res = await fetcher(quarantineUrl(batchId), { headers: { Accept: "application/json" } });
  const data = await readData<QuarantineBatchView[]>(res, "隔離一覧の取得に失敗しました");
  return data ?? [];
}

/**
 * 選択した pending 行を本登録する（POST /api/imports/[batchId]/accept）。
 * invalid / 本登録済み行を指定すると API が 409 を返す → 専用メッセージで throw する（§10.1：
 * 失敗行は本登録できない）。成功時は本登録件数と auto-snapshot を返す。
 */
export async function acceptRows(
  batchId: string,
  rowIds: string[],
  fetcher: typeof fetch = fetch,
): Promise<AcceptOutcome> {
  const res = await fetcher(acceptUrl(batchId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rowIds }),
  });
  if (res.status === 409) {
    throw new Error("invalid または本登録済みの行は本登録できません");
  }
  if (res.status === 404) {
    throw new Error("対象のバッチ／行が見つかりません");
  }
  if (!res.ok) {
    throw new Error(`本登録に失敗しました（${res.status}）`);
  }
  const body = (await res.json()) as {
    data?: { accepted: unknown[]; snapshot: AcceptOutcome["snapshot"] };
  };
  if (!body.data) {
    throw new Error("本登録の応答が不正です");
  }
  return { acceptedCount: body.data.accepted.length, snapshot: body.data.snapshot };
}

/** payloadJson（直列化 RawSignalInput）を表示用に要約する。壊れていても落ちない。 */
export function summarizePayload(payloadJson: string | null): {
  sourceType: string;
  rawText: string;
  observedEntity: string;
} {
  const dash = { sourceType: "—", rawText: "—", observedEntity: "—" };
  if (!payloadJson) return dash;
  try {
    const p = JSON.parse(payloadJson) as Record<string, unknown>;
    return {
      sourceType: typeof p.sourceType === "string" ? p.sourceType : "—",
      rawText: typeof p.rawText === "string" ? p.rawText : "—",
      observedEntity: typeof p.observedEntity === "string" ? p.observedEntity : "—",
    };
  } catch {
    return { ...dash, rawText: "(payload 解析不能)" };
  }
}

/** errorsJson（直列化 string[]）を表示用の理由配列にする。壊れていても落ちない。 */
export function parseRowErrors(errorsJson: string | null): string[] {
  if (!errorsJson) return [];
  try {
    const parsed = JSON.parse(errorsJson) as unknown;
    if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    return [String(parsed)];
  } catch {
    return ["(理由の解析に失敗しました)"];
  }
}

/** pending 行の id 全部（全選択用）。 */
export function allPendingIds(pending: QuarantineRowView[]): string[] {
  return pending.map((r) => r.id);
}

/** 選択集合に id を 1 件トグルする純関数（テスト用）。 */
export function toggleSelection(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

const SECTION_TITLE_STYLE = { fontSize: 14, fontWeight: 600, margin: "20px 0 8px" } as const;

/** presentational props（状態は持たない・静的描画でスモークテストできる）。 */
export type QuarantinePanelProps = {
  view: QuarantineBatchView | null;
  loading: boolean;
  selected: string[];
  accepting: boolean;
  onToggleRow: (id: string) => void;
  onToggleAll: () => void;
  onAcceptClick: () => void;
};

/**
 * 隔離行の表示本体（presentational）。pending はチェックボックス付きテーブル、invalid は
 * 行番号＋理由（accept 不可）。accept ボタンは選択 0 件のとき無効。
 */
export function QuarantinePanel({
  view,
  loading,
  selected,
  accepting,
  onToggleRow,
  onToggleAll,
  onAcceptClick,
}: QuarantinePanelProps) {
  if (!view) {
    return (
      <p style={{ color: "#667085", fontSize: 13 }}>
        {loading ? "隔離一覧を読み込み中…" : "取り込み済みのバッチはありません。"}
      </p>
    );
  }

  const { batch, pending, invalid, accepted } = view;
  const allSelected = pending.length > 0 && selected.length === pending.length;

  const pendingColumns: Column<QuarantineRowView>[] = [
    {
      key: "select",
      header: (
        <input
          type="checkbox"
          checked={allSelected}
          onChange={onToggleAll}
          aria-label="pending 行を全選択"
        />
      ),
      render: (row) => (
        <input
          type="checkbox"
          checked={selected.includes(row.id)}
          onChange={() => onToggleRow(row.id)}
          aria-label={`行 ${row.rowNumber} を選択`}
        />
      ),
    },
    { key: "rowNumber", header: "行", render: (row) => row.rowNumber },
    {
      key: "sourceType",
      header: "種別",
      render: (row) => <Badge tone="info">{summarizePayload(row.payloadJson).sourceType}</Badge>,
    },
    { key: "rawText", header: "観測事実", render: (row) => summarizePayload(row.payloadJson).rawText },
    {
      key: "observedEntity",
      header: "観測対象",
      render: (row) => summarizePayload(row.payloadJson).observedEntity,
    },
  ];

  return (
    <section>
      <div style={{ fontSize: 13, color: "#667085" }}>
        バッチ <strong>{batch.id}</strong>（origin: {batch.origin} / format: {batch.format}）
        {batch.note ? <span> — {batch.note}</span> : null}
      </div>

      <h3 style={SECTION_TITLE_STYLE}>
        本登録できる行（pending {pending.length} 件）
      </h3>
      <Table
        columns={pendingColumns}
        rows={pending}
        getRowKey={(row) => row.id}
        empty="本登録できる行はありません。"
      />

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
        <Button
          variant="primary"
          onClick={onAcceptClick}
          disabled={selected.length === 0 || accepting}
        >
          {accepting ? "本登録中…" : `選択した ${selected.length} 件を本登録`}
        </Button>
        <span style={{ color: "#667085", fontSize: 12 }}>
          accept した行だけが RawSignal になり Inbox に現れます。
        </span>
      </div>

      <h3 style={SECTION_TITLE_STYLE}>
        本登録できない行（invalid {invalid.length} 件）
      </h3>
      {invalid.length === 0 ? (
        <p style={{ color: "#667085", fontSize: 13 }}>invalid な行はありません。</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {invalid.map((row) => (
            <li
              key={row.id}
              style={{
                border: "1px solid #fecdca",
                borderRadius: 8,
                padding: "8px 12px",
                marginBottom: 8,
                background: "#fffbfa",
                fontSize: 13,
              }}
            >
              <span style={{ color: "#b42318", fontWeight: 600 }}>行 {row.rowNumber}</span>
              <span style={{ color: "#667085", marginLeft: 8 }}>本登録できません（理由）:</span>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "#b42318" }}>
                {parseRowErrors(row.errorsJson).map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {accepted.length > 0 ? (
        <p style={{ color: "#067647", fontSize: 13, marginTop: 16 }}>
          本登録済み: {accepted.length} 件
        </p>
      ) : null}
    </section>
  );
}

export type QuarantineReviewProps = {
  /** 表示・accept 対象のバッチ id（import 後に親から渡る）。 */
  batchId: string;
  /** accept 成功時のコールバック（件数を親に通知）。 */
  onAccepted?: (count: number) => void;
  /** テスト用の fetch 差し替え（既定は global fetch）。 */
  fetcher?: typeof fetch;
};

/**
 * Quarantine レビュー本体。batchId の隔離一覧を取得し、pending 行の選択 → 確認 → accept を扱う。
 * accept 前に「N 件を本登録します」を確認モーダルで挟む（誤本登録の防止・auto-snapshot と整合）。
 */
export function QuarantineReview({ batchId, onAccepted, fetcher = fetch }: QuarantineReviewProps) {
  const [view, setView] = useState<QuarantineBatchView | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const guardRef = useRef(createLatestGuard());

  const load = useCallback(async () => {
    const token = guardRef.current.next();
    setLoading(true);
    setError(null);
    try {
      const views = await fetchQuarantine(batchId, fetcher);
      if (!guardRef.current.isCurrent(token)) return;
      setView(views[0] ?? null);
      // 取得のたびに選択をリセット（accept 反映後に古い選択を引きずらない）。
      setSelected([]);
    } catch (e) {
      if (!guardRef.current.isCurrent(token)) return;
      setError(e instanceof Error ? e.message : "隔離一覧の取得に失敗しました");
    } finally {
      if (guardRef.current.isCurrent(token)) setLoading(false);
    }
  }, [batchId, fetcher]);

  // batchId が変わるたびに読み込む。setState を effect 本体から外へ出すためタイマ経由で実行する
  // （task-19〜22 と同じ流儀。cascading render 警告を避ける）。
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const handleToggleRow = useCallback((id: string) => {
    setSelected((prev) => toggleSelection(prev, id));
  }, []);

  const handleToggleAll = useCallback(() => {
    setSelected((prev) => {
      const pending = view?.pending ?? [];
      return prev.length === pending.length ? [] : allPendingIds(pending);
    });
  }, [view]);

  const handleConfirmAccept = useCallback(() => {
    if (accepting || selected.length === 0) return;
    setAccepting(true);
    setError(null);
    void (async () => {
      try {
        const outcome = await acceptRows(batchId, selected, fetcher);
        setConfirmOpen(false);
        onAccepted?.(outcome.acceptedCount);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "本登録に失敗しました");
        setConfirmOpen(false);
      } finally {
        setAccepting(false);
      }
    })();
  }, [accepting, selected, batchId, fetcher, onAccepted, load]);

  return (
    <div>
      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13, marginBottom: 12 }}>
          {error}
        </p>
      ) : null}

      <QuarantinePanel
        view={view}
        loading={loading}
        selected={selected}
        accepting={accepting}
        onToggleRow={handleToggleRow}
        onToggleAll={handleToggleAll}
        onAcceptClick={() => setConfirmOpen(true)}
      />

      {/* accept 前確認（誤本登録の防止・§18.4 auto-snapshot と整合）。 */}
      <Modal
        open={confirmOpen}
        onClose={() => (accepting ? undefined : setConfirmOpen(false))}
        title="本登録の確認"
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={accepting}>
              キャンセル
            </Button>
            <Button variant="primary" onClick={handleConfirmAccept} disabled={accepting}>
              {accepting ? "本登録中…" : "本登録する"}
            </Button>
          </div>
        }
      >
        <p style={{ fontSize: 14 }}>
          選択した <strong>{selected.length}</strong> 件を本登録します。本登録すると RawSignal として
          Inbox に現れます。よろしいですか？
        </p>
      </Modal>
    </div>
  );
}
