"use client";

import { useCallback, useState } from "react";

import { PageHeader } from "../../components/layout/PageHeader";
import { ImportDropzone, type ImportSummary } from "../../components/import/ImportDropzone";
import { QuarantineReview } from "../../components/import/QuarantineReview";

// task-23 — Import 画面（spec v2 §10.1 / §11.2）。
// JSON / CSV を投入 → quarantine（隔離）で人間が確認 → 選択行を accept して RawSignal へ本登録する。
// AI / 外部データを DB に直接入れない関門の UI（自動 accept は禁止・必ず人間）。
//
// オーケストレーションだけを持つ: ImportDropzone（投入 → batchId 取得）と QuarantineReview
// （その batch の pending/invalid 表示・選択・accept）を束ねる。

export default function ImportsPage() {
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleImported = useCallback((s: ImportSummary) => {
    setSummary(s);
    setNotice(
      `取り込みました（本登録できる ${s.pendingCount} 件 / invalid ${s.invalidCount} 件）。` +
        "下で内容を確認し、本登録する行を選んで accept してください。",
    );
  }, []);

  const handleAccepted = useCallback((count: number) => {
    setNotice(`${count} 件を本登録しました。Inbox に未処理の Raw Signal として現れます。`);
  }, []);

  return (
    <div>
      <PageHeader
        title="Imports"
        description="JSON / CSV を取り込み、隔離（quarantine）で確認してから本登録します。AI・外部データを DB に直接入れない関門です。"
      />

      <ImportDropzone onImported={handleImported} />

      {notice ? (
        <p
          role="status"
          style={{
            background: "#eef4ff",
            border: "1px solid #b2ccff",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {notice}
        </p>
      ) : null}

      {summary ? (
        <QuarantineReview batchId={summary.batchId} onAccepted={handleAccepted} />
      ) : null}
    </div>
  );
}
