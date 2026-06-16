import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { NAV_ITEMS } from "../../components/layout/navItems";
import { DeltaBadge, WatchlistRow, formatCheckedAt } from "../../components/watchlist/WatchlistRow";
import { WatchlistFormDialog } from "../../components/watchlist/WatchlistFormDialog";
import { UpdateValueDialog } from "../../components/watchlist/UpdateValueDialog";
import {
  buildWatchlistListUrl,
  createWatchlist,
  deleteWatchlist,
  deltaPresentation,
  emptyWatchlistFilter,
  fetchWatchlist,
  formValuesFromItem,
  recordWatchlistValue,
  toWriteBody,
  updateWatchlist,
  type WatchlistFormValues,
  type WatchlistItem,
} from "../../lib/api/watchlistClient";

// task-37 — Watchlist UI（spec v2 §9.8）。
// vitest 環境は node のため、DOM 依存を足さず react-dom/server の静的描画＋純関数（fetcher DI）で
// 受入基準を検証する（shell.test.tsx / linkDialog.test.tsx と同方式）。import は相対パス。
// ※ 配置は既存慣例（UI テストは tests/ui/）かつ task-37 doc 記載のパス。vitest.config.ts の
//   include（tests/**・lib/**）で拾われる（queue 記載の app/watchlist/__tests__/ は include 外のため不採用）。

// ---------------------------------------------------------------------------
// fixtures / helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<WatchlistItem> = {}): WatchlistItem {
  return {
    id: "wl-1",
    entityType: "competitor_app",
    entityName: "Acme 請求書アプリ",
    locale: null,
    metricName: "ランキング",
    lastValue: "5",
    currentValue: "3",
    deltaFlag: "down",
    lastCheckedAt: "2026-06-16T12:00:00.000Z",
    linkedCandidateId: null,
    note: null,
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function emptyForm(): WatchlistFormValues {
  return {
    entityType: "competitor_app",
    entityName: "",
    metricName: "",
    locale: "",
    linkedCandidateId: "",
    note: "",
  };
}

type Call = { url: string; init?: RequestInit };

/** 呼び出し URL/init を記録し、固定 JSON を返す fetch ダブル。 */
function makeFetcher(body: unknown, status = 200): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

// ---------------------------------------------------------------------------
// client: URL 組立 / ボディ整形 / delta 表現
// ---------------------------------------------------------------------------

describe("watchlistClient: URL とボディ整形", () => {
  it("buildWatchlistListUrl は空フィルタで素の URL、entityType 指定で query を積む", () => {
    expect(buildWatchlistListUrl(emptyWatchlistFilter())).toBe("/api/watchlist");
    expect(buildWatchlistListUrl({ entityType: "keyword" })).toBe(
      "/api/watchlist?entityType=keyword",
    );
  });

  it("toWriteBody は必須を残し、空の任意フィールド（特に空文字 linkedCandidateId）を省く", () => {
    const body = toWriteBody({
      entityType: "ranking",
      entityName: "  総合1位  ",
      metricName: "",
      locale: "",
      linkedCandidateId: "", // 空文字は API の .min(1) が 400 にするため積まない
      note: "",
    });
    expect(body).toEqual({ entityType: "ranking", entityName: "総合1位" });
    expect("linkedCandidateId" in body).toBe(false);
  });

  it("toWriteBody は非空の linkedCandidateId / 任意フィールドを積む", () => {
    const body = toWriteBody({
      entityType: "competitor_app",
      entityName: "Acme",
      metricName: "価格",
      locale: "ja-JP",
      linkedCandidateId: "cand-9",
      note: "メモ",
    });
    expect(body).toEqual({
      entityType: "competitor_app",
      entityName: "Acme",
      metricName: "価格",
      locale: "ja-JP",
      linkedCandidateId: "cand-9",
      note: "メモ",
    });
  });

  it("formValuesFromItem は null を空文字へ倒す", () => {
    const v = formValuesFromItem(makeItem({ metricName: null, linkedCandidateId: null }));
    expect(v.metricName).toBe("");
    expect(v.linkedCandidateId).toBe("");
    expect(v.entityName).toBe("Acme 請求書アプリ");
  });

  it("deltaPresentation は色だけに依存しないアイコン＋テキストを返す（§9.8 / a11y）", () => {
    expect(deltaPresentation("up")).toMatchObject({ icon: "↑", label: "上昇", tone: "danger" });
    expect(deltaPresentation("down")).toMatchObject({ icon: "↓", label: "下降", tone: "info" });
    expect(deltaPresentation("unchanged")).toMatchObject({
      icon: "→",
      label: "横ばい",
      tone: "neutral",
    });
    // 未知 / 初回は薄字の不明。
    expect(deltaPresentation("unknown")).toMatchObject({ label: "不明", muted: true });
  });
});

// ---------------------------------------------------------------------------
// client: API 呼び出し（fetcher DI）
// ---------------------------------------------------------------------------

describe("watchlistClient: API 呼び出し", () => {
  it("fetchWatchlist は data を返し、フィルタを URL に反映する", async () => {
    const { fetcher, calls } = makeFetcher({ data: [makeItem()] });
    const items = await fetchWatchlist({ entityType: "competitor_app" }, fetcher);
    expect(items).toHaveLength(1);
    expect(calls[0].url).toBe("/api/watchlist?entityType=competitor_app");
  });

  it("createWatchlist は POST で toWriteBody を送る（空 linkedCandidateId を含めない）", async () => {
    const { fetcher, calls } = makeFetcher({ data: makeItem() });
    await createWatchlist({ ...emptyForm(), entityName: "Acme" }, fetcher);
    expect(calls[0].url).toBe("/api/watchlist");
    expect(calls[0].init?.method).toBe("POST");
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent).toEqual({ entityType: "competitor_app", entityName: "Acme" });
  });

  it("updateWatchlist は PUT /api/watchlist/[id] を叩く", async () => {
    const { fetcher, calls } = makeFetcher({ data: makeItem() });
    await updateWatchlist("wl-1", { ...emptyForm(), entityName: "Acme2" }, fetcher);
    expect(calls[0].url).toBe("/api/watchlist/wl-1");
    expect(calls[0].init?.method).toBe("PUT");
  });

  it("recordWatchlistValue は PATCH /api/watchlist/[id] に { value } を送る（updateValue 導線）", async () => {
    const { fetcher, calls } = makeFetcher({ data: makeItem({ currentValue: "1" }) });
    const updated = await recordWatchlistValue("wl-1", "1", fetcher);
    expect(calls[0].url).toBe("/api/watchlist/wl-1");
    expect(calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ value: "1" });
    expect(updated.currentValue).toBe("1");
  });

  it("deleteWatchlist は DELETE を叩き、!ok なら throw する", async () => {
    const ok = makeFetcher({ data: { id: "wl-1" } });
    await expect(deleteWatchlist("wl-1", ok.fetcher)).resolves.toBeUndefined();
    expect(ok.calls[0].init?.method).toBe("DELETE");

    const ng = makeFetcher({ error: { message: "x" } }, 500);
    await expect(deleteWatchlist("wl-1", ng.fetcher)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 描画: 行 / delta バッジ / フォーム / 値更新ダイアログ
// ---------------------------------------------------------------------------

describe("WatchlistRow 描画", () => {
  it("対象・指標・前回値→今回値・操作ボタンを描画する", () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <WatchlistRow
            item={makeItem()}
            onRecordValue={() => {}}
            onEdit={() => {}}
            onDelete={() => {}}
          />
        </tbody>
      </table>,
    );
    expect(html).toContain("Acme 請求書アプリ");
    expect(html).toContain("競合アプリ"); // entityType ラベル
    expect(html).toContain("ランキング"); // metricName
    expect(html).toContain("5"); // lastValue
    expect(html).toContain("3"); // currentValue
    expect(html).toContain("今回値を記録");
    expect(html).toContain("編集");
    expect(html).toContain("削除");
    expect(html).toContain("2026-06-16"); // lastCheckedAt（日付部分）
  });

  it("紐付け候補があれば displayId/title のリンク、無ければ — を描画する", () => {
    const linked = renderToStaticMarkup(
      <table>
        <tbody>
          <WatchlistRow
            item={makeItem({ linkedCandidateId: "cand-9" })}
            candidate={{ id: "cand-9", displayId: "CND-9", title: "経理自動化" }}
            onRecordValue={() => {}}
            onEdit={() => {}}
            onDelete={() => {}}
          />
        </tbody>
      </table>,
    );
    expect(linked).toContain('href="/candidates/cand-9"');
    expect(linked).toContain("CND-9");
    expect(linked).toContain("経理自動化");
  });

  it("formatCheckedAt は未記録で — 、ISO は日付部分を返す", () => {
    expect(formatCheckedAt(null)).toBe("—");
    expect(formatCheckedAt("2026-06-16T12:00:00.000Z")).toBe("2026-06-16");
  });
});

describe("DeltaBadge 描画（色＋アイコン＋テキスト）", () => {
  it("up は danger トーン＋↑＋上昇", () => {
    const html = renderToStaticMarkup(<DeltaBadge flag="up" />);
    expect(html).toContain("mi-badge--danger");
    expect(html).toContain("↑");
    expect(html).toContain("上昇");
  });

  it("down は info トーン＋↓＋下降、unknown は薄字＋不明", () => {
    const down = renderToStaticMarkup(<DeltaBadge flag="down" />);
    expect(down).toContain("mi-badge--info");
    expect(down).toContain("下降");

    const unknown = renderToStaticMarkup(<DeltaBadge flag="unknown" />);
    expect(unknown).toContain("mi-badge--muted");
    expect(unknown).toContain("不明");
  });
});

describe("WatchlistFormDialog 描画", () => {
  it("新規作成は種別/対象名/紐付けなし option と『追加する』を描画する", () => {
    const html = renderToStaticMarkup(
      <WatchlistFormDialog
        open
        candidates={[{ id: "cand-9", displayId: "CND-9", title: "経理自動化" }]}
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(html).toContain("Watchlist を追加");
    expect(html).toContain("競合アプリ"); // entityType option ラベル
    expect(html).toContain("（紐付けなし）");
    expect(html).toContain("CND-9 経理自動化");
    expect(html).toContain("追加する");
  });

  it("編集（initial 指定）はタイトルと『更新する』を描画する", () => {
    const html = renderToStaticMarkup(
      <WatchlistFormDialog
        open
        initial={formValuesFromItem(makeItem())}
        candidates={[]}
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(html).toContain("Watchlist を編集");
    expect(html).toContain("更新する");
    expect(html).toContain("Acme 請求書アプリ"); // 初期値
  });
});

describe("UpdateValueDialog 描画", () => {
  it("いまの値を文脈表示し、今回値入力と記録ボタンを描画する", () => {
    const html = renderToStaticMarkup(
      <UpdateValueDialog
        item={makeItem({ currentValue: "3" })}
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(html).toContain("今回値を記録");
    expect(html).toContain("いまの値");
    expect(html).toContain("記録する");
  });

  it("item が null なら何も描画しない", () => {
    expect(
      renderToStaticMarkup(
        <UpdateValueDialog item={null} onClose={() => {}} onSubmit={async () => {}} />,
      ),
    ).toBe("");
  });
});

describe("ナビ invariant（task-37）", () => {
  it("ナビに /watchlist が Candidates の次に含まれる", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(hrefs).toContain("/watchlist");
    expect(hrefs.indexOf("/watchlist")).toBe(hrefs.indexOf("/candidates") + 1);
  });
});
