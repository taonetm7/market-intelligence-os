import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ImportDropzone,
  IMPORT_URL,
  isBlankContent,
  submitImport,
  type ImportFormat,
} from "../../components/import/ImportDropzone";
import {
  QUARANTINE_URL,
  QuarantinePanel,
  acceptRows,
  acceptUrl,
  allPendingIds,
  createLatestGuard,
  fetchQuarantine,
  parseRowErrors,
  quarantineUrl,
  summarizePayload,
  toggleSelection,
  type QuarantineBatchView,
  type QuarantineRowView,
} from "../../components/import/QuarantineReview";

// task-23 Import UI（spec v2 §10.1 / §11.2）。
// テスト基盤に DOM / インタラクション依存は足さない方針のため、投入（fetcher DI）・accept・
// 選択・整形などのロジックを純関数として駆動して受入基準を検証し、描画は react-dom/server の
// 静的描画で確認する。テストの import は相対パス（@/ エイリアスは vitest 非対応）。

/** Response 風の最小オブジェクトを作る。 */
function resp(status: number, data?: unknown, error?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (error ? { error } : { data }),
  } as unknown as Response;
}

/**
 * 状態を持つ擬似 Import API。投入 → quarantine 取得 → accept → Inbox 未処理キューまでを一通り扱い、
 * 「accept した行が RawSignal になり Inbox に現れる」「invalid は accept 不可」を E2E 的に検証できる。
 * パーサ本体（task-14）はここでは再現せず、seed で pending / invalid 行を直接与える（UI/データ
 * 経路の検証に集中する）。
 */
function makeFakeImportApi(seed: {
  pending: Array<{ rowNumber: number; payload: Record<string, unknown> }>;
  invalid: Array<{ rowNumber: number; errors: string[] }>;
}) {
  const batches = new Map<string, { batch: QuarantineBatchView["batch"]; rows: QuarantineRowView[] }>();
  const rawSignals: Array<Record<string, unknown> & { id: string; status: string; linked: boolean }> = [];
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let batchSeq = 0;
  let rowSeq = 0;
  let rsSeq = 0;

  const fetcher = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    // 投入: 隔離バッチを作成し pending / invalid を返す。
    if (url === IMPORT_URL && method === "POST") {
      batchSeq += 1;
      const batchId = `batch-${batchSeq}`;
      const rows: QuarantineRowView[] = [];
      for (const p of seed.pending) {
        rowSeq += 1;
        rows.push({
          id: `row-${rowSeq}`,
          rowNumber: p.rowNumber,
          status: "pending",
          payloadJson: JSON.stringify(p.payload),
          errorsJson: null,
          rawSignalId: null,
        });
      }
      for (const iv of seed.invalid) {
        rowSeq += 1;
        rows.push({
          id: `row-${rowSeq}`,
          rowNumber: iv.rowNumber,
          status: "invalid",
          payloadJson: null,
          errorsJson: JSON.stringify(iv.errors),
          rawSignalId: null,
        });
      }
      const batch = {
        id: batchId,
        origin: "import",
        format: (body as { format: string }).format,
        note: null,
        createdAt: "2026-06-12T00:00:00.000Z",
      };
      batches.set(batchId, { batch, rows });
      return resp(201, {
        batch,
        pending: rows.filter((r) => r.status === "pending"),
        invalid: rows.filter((r) => r.status === "invalid"),
      });
    }

    // quarantine 一覧（batchId 任意）。
    if (url.startsWith(QUARANTINE_URL) && method === "GET") {
      const bid = new URL(url, "http://x").searchParams.get("batchId");
      const data = [...batches.values()]
        .filter((e) => !bid || e.batch.id === bid)
        .map((e) => ({
          batch: e.batch,
          pending: e.rows.filter((r) => r.status === "pending"),
          invalid: e.rows.filter((r) => r.status === "invalid"),
          accepted: e.rows.filter((r) => r.status === "accepted"),
        }));
      return resp(200, data);
    }

    // accept: pending 行を RawSignal へ本登録。invalid を含むと 409。
    const aMatch = /^\/api\/imports\/([^/]+)\/accept$/.exec(url);
    if (aMatch && method === "POST") {
      const entry = batches.get(aMatch[1]);
      if (!entry) return resp(404, undefined, { message: "ImportBatch が見つかりません" });
      const rowIds: string[] | undefined = body?.rowIds;
      const targets = rowIds
        ? entry.rows.filter((r) => rowIds.includes(r.id))
        : entry.rows.filter((r) => r.status === "pending");
      if (targets.some((r) => r.status === "invalid")) {
        return resp(409, undefined, { message: "invalid な隔離行は本登録できません" });
      }
      const accepted: Array<{ row: QuarantineRowView; rawSignal: unknown }> = [];
      for (const row of targets.filter((r) => r.status === "pending")) {
        rsSeq += 1;
        const payload = JSON.parse(row.payloadJson ?? "{}") as Record<string, unknown>;
        const rawSignal = {
          id: `rs-${rsSeq}`,
          displayId: `RS-${rsSeq}`,
          status: "inbox",
          linked: false,
          ...payload,
        };
        rawSignals.push(rawSignal);
        row.status = "accepted";
        row.rawSignalId = rawSignal.id;
        accepted.push({ row: { ...row }, rawSignal });
      }
      return resp(201, {
        accepted,
        snapshot: {
          rawSignalCountBefore: rawSignals.length - accepted.length,
          acceptedCount: accepted.length,
          rawSignalCountAfter: rawSignals.length,
        },
      });
    }

    // Inbox 未処理キュー（accept 結果が現れることの検証）。
    if (url === "/api/raw-signals?unlinked=1" && method === "GET") {
      return resp(
        200,
        rawSignals.filter((rs) => rs.status === "inbox" && !rs.linked),
      );
    }

    return resp(500, undefined, { message: "unhandled" });
  }) as unknown as typeof fetch;

  return { fetcher, calls, batches, rawSignals };
}

/** pending / invalid を持つ隔離バッチビューのダミー。 */
function batchView(overrides: Partial<QuarantineBatchView> = {}): QuarantineBatchView {
  return {
    batch: {
      id: "batch-1",
      origin: "import",
      format: "json",
      note: null,
      createdAt: "2026-06-12T00:00:00.000Z",
    },
    pending: [
      {
        id: "row-1",
        rowNumber: 1,
        status: "pending",
        payloadJson: JSON.stringify({
          sourceType: "app_store",
          rawText: "競合アプリが値上げした",
          observedEntity: "Example App",
        }),
        errorsJson: null,
        rawSignalId: null,
      },
    ],
    invalid: [
      {
        id: "row-2",
        rowNumber: 2,
        status: "invalid",
        payloadJson: null,
        errorsJson: JSON.stringify(["rawText: 必須です"]),
        rawSignalId: null,
      },
    ],
    accepted: [],
    ...overrides,
  };
}

describe("Import: 連番ガード（stale response 対策）", () => {
  it("最新トークンだけを current とみなす", () => {
    const guard = createLatestGuard();
    const t1 = guard.next();
    const t2 = guard.next();
    expect(guard.isCurrent(t1)).toBe(false);
    expect(guard.isCurrent(t2)).toBe(true);
  });
});

describe("Import: URL 組み立て", () => {
  it("import は POST /api/raw-signals/import を使う", () => {
    expect(IMPORT_URL).toBe("/api/raw-signals/import");
  });

  it("quarantineUrl は batchId をクエリに付け、未指定なら素の URL", () => {
    expect(quarantineUrl()).toBe(QUARANTINE_URL);
    expect(quarantineUrl("batch-1")).toBe("/api/imports/quarantine?batchId=batch-1");
  });

  it("acceptUrl は batchId を含む accept パス", () => {
    expect(acceptUrl("batch-1")).toBe("/api/imports/batch-1/accept");
  });
});

describe("Import: submitImport（投入）", () => {
  it("format / content を送り、pending / invalid 件数を要約して返す", async () => {
    const api = makeFakeImportApi({
      pending: [{ rowNumber: 1, payload: { sourceType: "app_store", rawText: "値上げ" } }],
      invalid: [{ rowNumber: 2, errors: ["rawText: 必須です"] }],
    });

    const summary = await submitImport(
      { format: "json", content: '{"rawSignals":[{"sourceType":"app_store","rawText":"値上げ"}]}' },
      api.fetcher,
    );

    const post = api.calls.find((c) => c.url === IMPORT_URL);
    expect(post?.method).toBe("POST");
    expect((post?.body as { format: string }).format).toBe("json");
    expect(summary.pendingCount).toBe(1);
    expect(summary.invalidCount).toBe(1);
    expect(summary.batchId).toBe("batch-1");
  });

  it("投入失敗（!ok）は throw する", async () => {
    const failing = (async () => resp(400, undefined, { message: "bad" })) as unknown as typeof fetch;
    await expect(
      submitImport({ format: "csv" as ImportFormat, content: "x" }, failing),
    ).rejects.toThrow();
  });

  it("isBlankContent は空白のみを空とみなす", () => {
    expect(isBlankContent("   \n ")).toBe(true);
    expect(isBlankContent('{"rawSignals":[]}')).toBe(false);
  });
});

describe("Import: fetchQuarantine（取得）", () => {
  it("batchId を付けて取得し、batch 単位ビューを返す", async () => {
    const api = makeFakeImportApi({
      pending: [{ rowNumber: 1, payload: { sourceType: "app_store", rawText: "値上げ" } }],
      invalid: [{ rowNumber: 2, errors: ["rawText: 必須です"] }],
    });
    const { batchId } = await submitImport({ format: "json", content: "{}" }, api.fetcher);

    const views = await fetchQuarantine(batchId, api.fetcher);
    expect(views).toHaveLength(1);
    expect(views[0].pending).toHaveLength(1);
    expect(views[0].invalid).toHaveLength(1);

    const get = api.calls.find((c) => c.method === "GET" && c.url.startsWith(QUARANTINE_URL));
    expect(get?.url).toBe("/api/imports/quarantine?batchId=batch-1");
  });
});

describe("Import: accept で選択行が RawSignal になり Inbox に現れる（受入基準）", () => {
  it("pending 行を accept すると RawSignal が作られ、Inbox 未処理キューに出る", async () => {
    const api = makeFakeImportApi({
      pending: [
        {
          rowNumber: 1,
          payload: { sourceType: "app_store", rawText: "競合が値上げ", observedEntity: "Example" },
        },
      ],
      invalid: [{ rowNumber: 2, errors: ["rawText: 必須です"] }],
    });

    const { batchId } = await submitImport({ format: "json", content: "{}" }, api.fetcher);
    const views = await fetchQuarantine(batchId, api.fetcher);
    const pendingRowId = views[0].pending[0].id;

    const outcome = await acceptRows(batchId, [pendingRowId], api.fetcher);
    expect(outcome.acceptedCount).toBe(1);
    expect(outcome.snapshot.rawSignalCountAfter).toBe(1);

    // 再取得すると当該行は accepted に移り pending から外れる。
    const after = await fetchQuarantine(batchId, api.fetcher);
    expect(after[0].pending).toHaveLength(0);
    expect(after[0].accepted).toHaveLength(1);

    // Inbox 未処理キューに RawSignal が現れる。
    const inboxRes = await api.fetcher("/api/raw-signals?unlinked=1");
    const inbox = ((await inboxRes.json()) as { data: Array<{ rawText: string }> }).data;
    expect(inbox).toHaveLength(1);
    expect(inbox[0].rawText).toBe("競合が値上げ");
  });

  it("invalid 行を accept しようとすると 409 で弾かれる（本登録不可）", async () => {
    const api = makeFakeImportApi({
      pending: [{ rowNumber: 1, payload: { sourceType: "app_store", rawText: "ok" } }],
      invalid: [{ rowNumber: 2, errors: ["rawText: 必須です"] }],
    });
    const { batchId } = await submitImport({ format: "json", content: "{}" }, api.fetcher);
    const views = await fetchQuarantine(batchId, api.fetcher);
    const invalidRowId = views[0].invalid[0].id;

    await expect(acceptRows(batchId, [invalidRowId], api.fetcher)).rejects.toThrow(/本登録できません/);

    // 弾かれたので RawSignal は作られず Inbox は空のまま。
    const inboxRes = await api.fetcher("/api/raw-signals?unlinked=1");
    const inbox = ((await inboxRes.json()) as { data: unknown[] }).data;
    expect(inbox).toHaveLength(0);
  });

  it("バッチ不在の accept は 404 を friendly に throw する", async () => {
    const api = makeFakeImportApi({ pending: [], invalid: [] });
    await expect(acceptRows("no-such-batch", ["row-x"], api.fetcher)).rejects.toThrow(/見つかりません/);
  });
});

describe("Import: 選択ロジック（純関数）", () => {
  it("toggleSelection は 1 件をトグルする", () => {
    expect(toggleSelection([], "a")).toEqual(["a"]);
    expect(toggleSelection(["a", "b"], "a")).toEqual(["b"]);
  });

  it("allPendingIds は pending 行の id 全部を返す", () => {
    expect(
      allPendingIds([
        { id: "r1" } as QuarantineRowView,
        { id: "r2" } as QuarantineRowView,
      ]),
    ).toEqual(["r1", "r2"]);
  });
});

describe("Import: 整形ヘルパ（壊れた入力に強い）", () => {
  it("summarizePayload は主要フィールドを取り出し、欠落は — にする", () => {
    expect(
      summarizePayload(JSON.stringify({ sourceType: "job", rawText: "求人増", observedEntity: "X" })),
    ).toEqual({ sourceType: "job", rawText: "求人増", observedEntity: "X" });
    expect(summarizePayload(null)).toEqual({ sourceType: "—", rawText: "—", observedEntity: "—" });
    expect(summarizePayload("not-json").rawText).toBe("(payload 解析不能)");
  });

  it("parseRowErrors は理由配列を返し、壊れていても落ちない", () => {
    expect(parseRowErrors(JSON.stringify(["a: x", "b: y"]))).toEqual(["a: x", "b: y"]);
    expect(parseRowErrors(null)).toEqual([]);
    expect(parseRowErrors("not-json")).toEqual(["(理由の解析に失敗しました)"]);
  });
});

describe("Import: 描画スモーク", () => {
  it("ImportDropzone はフォーマット選択・取り込みボタンを描画する", () => {
    const html = renderToStaticMarkup(<ImportDropzone onImported={() => {}} />);
    expect(html).toContain("quarantine に取り込む");
    expect(html).toContain("CSV（固定ヘッダ）");
    expect(html).toContain("取り込み内容");
  });

  it("QuarantinePanel は pending 行・invalid 理由・本登録ボタンを描画する", () => {
    const html = renderToStaticMarkup(
      <QuarantinePanel
        view={batchView()}
        loading={false}
        selected={["row-1"]}
        accepting={false}
        onToggleRow={() => {}}
        onToggleAll={() => {}}
        onAcceptClick={() => {}}
      />,
    );
    // pending 行の観測事実と種別。
    expect(html).toContain("競合アプリが値上げした");
    expect(html).toContain("app_store");
    // invalid 行の番号と理由（accept 不可）。
    expect(html).toContain("行 2");
    expect(html).toContain("rawText: 必須です");
    expect(html).toContain("本登録できません");
    // 選択 1 件 → 本登録ボタンに件数が出る。
    expect(html).toContain("選択した 1 件を本登録");
  });

  it("QuarantinePanel は view 未取得時に空表示を出す", () => {
    const html = renderToStaticMarkup(
      <QuarantinePanel
        view={null}
        loading={false}
        selected={[]}
        accepting={false}
        onToggleRow={() => {}}
        onToggleAll={() => {}}
        onAcceptClick={() => {}}
      />,
    );
    expect(html).toContain("取り込み済みのバッチはありません");
  });
});
