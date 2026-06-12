import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  RawSignalFilters,
  applyTagFilter,
  buildRawSignalListUrl,
  emptyRawSignalQuery,
  fetchRawSignals,
  SOURCE_TYPE_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
  type RawSignalQuery,
} from "../../components/raw-signal/RawSignalFilters";
import {
  RawSignalTable,
  formatAddedAt,
  originTone,
  rawSignalDetailHref,
  rawSignalLinkHref,
  statusTone,
  truncate,
  type RawSignalRow,
} from "../../components/raw-signal/RawSignalTable";
import { SOURCE_TYPE_VALUES, STATUS_VALUES } from "../../lib/validation/enums";

// task-19 Raw Signal 一覧（spec v2 §9.3）。
// テスト基盤に DOM/インタラクション依存は足さない方針のため、フィルタ→API クエリの
// マッピング・取得（fetcher DI）・タグ絞り込み・バッジ色などのロジックを純関数として
// 駆動して受入基準を検証し、描画は react-dom/server の静的描画で確認する。

/** 一覧 1 行のダミー。 */
function row(overrides: Partial<RawSignalRow> = {}): RawSignalRow {
  return {
    id: "rs1",
    displayId: "RS-20260612-001",
    addedAt: "2026-06-12T09:30:00.000Z",
    sourceType: "app_store",
    sourceName: "Example Store",
    rawText: "競合アプリが値上げした",
    observedEntity: "Example App",
    signalTags: ["pricing"],
    evidenceCount: 0,
    origin: "manual",
    status: "inbox",
    ...overrides,
  };
}

/** GET /api/raw-signals を受ける擬似 API。最後に呼ばれた URL を記録する。 */
function makeFakeApi(data: RawSignalRow[]) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe("RawSignalFilters: フィルタ選択肢", () => {
  it("sourceType / status の選択肢は task-02 の enum＋『すべて』空 option", () => {
    expect(SOURCE_TYPE_FILTER_OPTIONS[0]).toEqual({ value: "", label: "すべてのソース種別" });
    expect(SOURCE_TYPE_FILTER_OPTIONS.slice(1).map((o) => o.value)).toEqual([
      ...SOURCE_TYPE_VALUES,
    ]);
    expect(STATUS_FILTER_OPTIONS[0].value).toBe("");
    expect(STATUS_FILTER_OPTIONS.slice(1).map((o) => o.value)).toEqual([...STATUS_VALUES]);
  });
});

describe("buildRawSignalListUrl: フィルタが API クエリに反映される", () => {
  it("空クエリはパラメータなし", () => {
    expect(buildRawSignalListUrl(emptyRawSignalQuery())).toBe("/api/raw-signals");
  });

  it("sourceType / status / 未紐付け / q をクエリへマップする", () => {
    const url = buildRawSignalListUrl({
      sourceType: "app_store",
      status: "inbox",
      tag: "pricing",
      unlinkedOnly: true,
      q: "値上げ",
    });
    const params = new URL(url, "http://x").searchParams;
    expect(params.get("sourceType")).toBe("app_store");
    expect(params.get("status")).toBe("inbox");
    expect(params.get("unlinked")).toBe("1");
    expect(params.get("q")).toBe("値上げ");
    // タグは repository.list 非対応なのでサーバへは送らない（クライアント側で適用）。
    expect(params.has("tag")).toBe(false);
  });

  it("q は trim し、空白のみなら送らない", () => {
    expect(buildRawSignalListUrl({ ...emptyRawSignalQuery(), q: "   " })).toBe("/api/raw-signals");
    const url = buildRawSignalListUrl({ ...emptyRawSignalQuery(), q: "  値上げ  " });
    expect(new URL(url, "http://x").searchParams.get("q")).toBe("値上げ");
  });
});

describe("applyTagFilter: タグはクライアント側で絞り込む", () => {
  const rows = [
    row({ id: "a", signalTags: ["pricing", "ios"] }),
    row({ id: "b", signalTags: ["ux"] }),
    row({ id: "c", signalTags: [] }),
  ];

  it("空タグは全件素通し", () => {
    expect(applyTagFilter(rows, "").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("大文字小文字を無視して contains で絞り込む", () => {
    expect(applyTagFilter(rows, "PRICE").map((r) => r.id)).toEqual([]);
    expect(applyTagFilter(rows, "Pric").map((r) => r.id)).toEqual(["a"]);
    expect(applyTagFilter(rows, "u").map((r) => r.id)).toEqual(["b"]);
  });
});

describe("fetchRawSignals: 取得（fetcher DI）", () => {
  it("組み立てた URL で取得し data を返す", async () => {
    const { calls, fetcher } = makeFakeApi([row()]);
    const result = await fetchRawSignals(
      { ...emptyRawSignalQuery(), sourceType: "app_store" },
      fetcher,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("sourceType=app_store");
    expect(result).toHaveLength(1);
    expect(result[0].displayId).toBe("RS-20260612-001");
  });

  it("取得後にタグをクライアント側で適用する", async () => {
    const { fetcher } = makeFakeApi([
      row({ id: "a", signalTags: ["pricing"] }),
      row({ id: "b", signalTags: ["ux"] }),
    ]);
    const result = await fetchRawSignals({ ...emptyRawSignalQuery(), tag: "pricing" }, fetcher);
    expect(result.map((r) => r.id)).toEqual(["a"]);
  });

  it("!ok なら例外を投げる", async () => {
    const failing = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchRawSignals(emptyRawSignalQuery(), failing)).rejects.toThrow();
  });
});

describe("RawSignalTable: バッジ色・整形・導線", () => {
  it("status / origin のバッジ色は未知値で neutral にフォールバック", () => {
    expect(statusTone("inbox")).toBe("info");
    expect(statusTone("ignored")).toBe("warning");
    expect(statusTone("archived")).toBe("neutral");
    expect(statusTone("???")).toBe("neutral");
    expect(originTone("ai")).toBe("success");
    expect(originTone("import")).toBe("info");
    expect(originTone("manual")).toBe("neutral");
    expect(originTone("???")).toBe("neutral");
  });

  it("追加日は ISO を YYYY-MM-DD に整形し、本文は省略する", () => {
    expect(formatAddedAt("2026-06-12T09:30:00.000Z")).toBe("2026-06-12");
    expect(truncate("a".repeat(100)).endsWith("…")).toBe(true);
    expect(truncate("短い")).toBe("短い");
  });

  it("行導線は詳細(編集)と link の href を持つ", () => {
    expect(rawSignalDetailHref("rs1")).toBe("/raw-signals/rs1");
    expect(rawSignalLinkHref("rs1")).toBe("/raw-signals/rs1/link");
  });
});

describe("RawSignalTable: 描画", () => {
  it("§9.3 のカラム・バッジ・行導線を描画する", () => {
    const html = renderToStaticMarkup(<RawSignalTable rows={[row({ evidenceCount: 2 })]} />);
    // カラム見出し
    expect(html).toContain("ID");
    expect(html).toContain("追加日");
    expect(html).toContain("観測事実");
    expect(html).toContain("タグ");
    expect(html).toContain("紐付け候補数");
    expect(html).toContain("origin");
    expect(html).toContain("status");
    // セル内容
    expect(html).toContain("RS-20260612-001");
    expect(html).toContain("2026-06-12");
    expect(html).toContain("pricing");
    expect(html).toContain("競合アプリが値上げした");
    // origin / status はバッジ
    expect(html).toContain("mi-badge");
    // 行導線（編集 / link）
    expect(html).toContain('href="/raw-signals/rs1"');
    expect(html).toContain('href="/raw-signals/rs1/link"');
  });

  it("空のときは空メッセージを出す", () => {
    const html = renderToStaticMarkup(<RawSignalTable rows={[]} />);
    expect(html).toContain("Raw Signal がありません");
  });
});

describe("RawSignalFilters: 描画", () => {
  it("検索・ソース種別・ステータス・タグ・未紐付けを描画する", () => {
    const value: RawSignalQuery = emptyRawSignalQuery();
    const html = renderToStaticMarkup(<RawSignalFilters value={value} onChange={() => {}} />);
    expect(html).toContain("検索");
    expect(html).toContain("ソース種別");
    expect(html).toContain("ステータス");
    expect(html).toContain("未紐付けのみ");
    expect(html).toContain('type="checkbox"');
    // enum の選択肢と『すべて』空 option が出る。
    expect(html).toContain('value="app_store"');
    expect(html).toContain("すべてのソース種別");
  });
});
