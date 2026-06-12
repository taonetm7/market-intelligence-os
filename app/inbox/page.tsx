"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { PageHeader } from "../../components/layout/PageHeader";
import { Button, Modal } from "../../components/ui";
import { QuickCapture } from "../../components/raw-signal/QuickCapture";
import { LinkDialog } from "../../components/evidence/LinkDialog";
import {
  TriageQueue,
  archiveSignal,
  fetchInboxQueue,
  ignoreSignal,
  promoteToCandidate,
  type TriageSignal,
} from "../../components/inbox/TriageQueue";

// task-18 — Inbox Triage 画面（spec v2 §9.1 既定ランディング）。
// 日次の主作業＝「未処理 Raw Signal を捌く」。未紐付けキュー（GET /api/raw-signals?unlinked=1）
// を上から処理し、各 Signal を Link / 新規候補化 / Ignore / Archive する。処理した Signal は
// キューから消える（unlinked=1 は status inbox かつ Evidence 0 件のみを返す）。捌きながら
// Quick Capture（task-17）で新しい Signal を追加できる。
//
// 取得・トリアージ操作のロジックは components/inbox 側の純関数に切り出し済み。ここでは
// 状態（キュー・処理中行・通知）とオーケストレーション（操作 → 再取得）だけを持つ。

/**
 * 最新リクエストだけを採用する連番ガード（stale response 対策）。
 * 操作のたびにキューを取り直すため、遅延差で古い取得結果が新しい結果を上書きし得る。
 * 連番トークンを発行し、応答到着時に最新でなければ破棄する。task-19/20 と同一意図。
 * 共有ライブラリ化は本タスクの write scope 外（指示役確認が必要）のため局所定義する。
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

export default function InboxPage() {
  const [signals, setSignals] = useState<TriageSignal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  // Link UI（task-22 导线A）を開いている対象 Signal。null なら閉じている。
  const [linkSignal, setLinkSignal] = useState<TriageSignal | null>(null);
  const guardRef = useRef(createLatestGuard());

  const load = useCallback(async () => {
    const token = guardRef.current.next();
    setLoading(true);
    setError(null);
    try {
      const result = await fetchInboxQueue();
      if (!guardRef.current.isCurrent(token)) return;
      setSignals(result);
    } catch (e) {
      if (!guardRef.current.isCurrent(token)) return;
      setError(e instanceof Error ? e.message : "キューの取得に失敗しました");
      setSignals([]);
    } finally {
      if (guardRef.current.isCurrent(token)) setLoading(false);
    }
  }, []);

  // 初回マウントでキューを取得する。setState を effect 本体から外へ出すため
  // タイマ経由で実行する（task-19/20 と同じ流儀。cascading render 警告を避ける）。
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  /** トリアージ操作を実行 → 成功なら通知してキューを取り直す（処理済みが外れる）。 */
  const runAction = useCallback(
    async (signal: TriageSignal, action: () => Promise<void>, successMessage: string) => {
      if (pendingId) return; // 1 件ずつ処理（多重送信防止）。
      setPendingId(signal.id);
      setError(null);
      setNotice(null);
      try {
        await action();
        setNotice(successMessage);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "操作に失敗しました");
      } finally {
        setPendingId(null);
      }
    },
    [pendingId, load],
  );

  const handleIgnore = useCallback(
    (signal: TriageSignal) =>
      void runAction(signal, () => ignoreSignal(signal.id), `${signal.displayId} を Ignore しました`),
    [runAction],
  );

  const handleArchive = useCallback(
    (signal: TriageSignal) =>
      void runAction(
        signal,
        () => archiveSignal(signal.id),
        `${signal.displayId} を Archive しました`,
      ),
    [runAction],
  );

  const handlePromote = useCallback(
    (signal: TriageSignal) =>
      void runAction(
        signal,
        async () => {
          await promoteToCandidate(signal);
        },
        `${signal.displayId} を新規候補化しました`,
      ),
    [runAction],
  );

  // Link（task-22 导线A）: RawSignal を固定し、候補を検索して link するダイアログを開く。
  const handleLink = useCallback((signal: TriageSignal) => {
    setError(null);
    setNotice(null);
    setLinkSignal(signal);
  }, []);

  // link 成功 → 通知してキューを取り直す（link 済み Signal は unlinked=1 から外れキューから消える）。
  const handleLinked = useCallback(
    (signal: TriageSignal) => {
      setLinkSignal(null);
      setNotice(`${signal.displayId} を候補に link しました`);
      void load();
    },
    [load],
  );

  return (
    <>
      <PageHeader
        title="Inbox Triage"
        description="未処理の Raw Signal を上から捌く既定ランディング。Link / 新規候補化 / Ignore / Archive で処理します。"
      />

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <Button variant="primary" onClick={() => setCaptureOpen(true)}>
          Quick Capture
        </Button>
        <Button variant="ghost" onClick={() => void load()} disabled={loading}>
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

      <TriageQueue
        signals={signals}
        onLink={handleLink}
        onPromote={handlePromote}
        onIgnore={handleIgnore}
        onArchive={handleArchive}
        pendingId={pendingId}
        empty={loading ? "読み込み中…" : "未処理の Raw Signal はありません"}
      />

      <Modal
        open={captureOpen}
        onClose={() => setCaptureOpen(false)}
        title="Quick Capture"
      >
        {/* 捌きながら追加: 保存のたびにキューを取り直す（新規 Signal が即キューに載る）。 */}
        <QuickCapture onSaved={() => void load()} />
      </Modal>

      {/* Link UI（导线A）: RawSignal を固定し候補を検索して link する。閉じている間は描画しない。 */}
      {linkSignal ? (
        <LinkDialog
          open
          onClose={() => setLinkSignal(null)}
          rawSignalId={linkSignal.id}
          rawSignalLabel={linkSignal.displayId}
          onLinked={() => handleLinked(linkSignal)}
        />
      ) : null}
    </>
  );
}
