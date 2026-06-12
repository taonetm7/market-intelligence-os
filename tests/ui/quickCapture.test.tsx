import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  QuickCapture,
  buildRawSignalInput,
  emptyQuickCaptureFields,
  submitRawSignal,
  validateQuickCapture,
  SOURCE_TYPE_OPTIONS,
  type QuickCaptureFields,
} from "../../components/raw-signal/QuickCapture";
import { SOURCE_TYPE_VALUES } from "../../lib/validation/enums";

// task-17 Quick Capture（spec v2 §9.2 最重要 UX）。
// テスト基盤に DOM/インタラクション系の依存は足さない方針のため、
// インタラクションのロジックは純関数（validate / build / submit）に切り出し、
// それらを直接駆動して受け入れ条件を検証する。描画は react-dom/server の
// 静的描画で 4 項目フォームが出ることだけを確認する。

/** 4 項目を埋めた有効な入力を作る。 */
function validFields(overrides: Partial<QuickCaptureFields> = {}): QuickCaptureFields {
  return {
    ...emptyQuickCaptureFields(),
    sourceType: "app_store",
    rawText: "競合アプリが値上げした",
    url: "https://example.com/app",
    observedEntity: "Example App",
    ...overrides,
  };
}

/**
 * /api/raw-signals への POST を受ける擬似 API。
 * 受理した body を store に積み、201 を返す（= Raw Signal が増える）。
 */
function makeFakeApi() {
  const store: Array<Record<string, unknown>> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    expect(url).toBe("/api/raw-signals");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    store.push(body);
    return {
      ok: true,
      status: 201,
      json: async () => ({ data: { id: `rs-${store.length}`, ...body } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { store, fetcher };
}

describe("QuickCapture: 選択肢", () => {
  it("sourceType の選択肢は task-02 の enum 値タプルと一致する", () => {
    expect(SOURCE_TYPE_OPTIONS.map((o) => o.value)).toEqual([...SOURCE_TYPE_VALUES]);
  });
});

describe("QuickCapture: 入力組立", () => {
  it("4 項目を必須キー込みで組み立て、空の任意項目は落とす", () => {
    const input = buildRawSignalInput(validFields({ url: "", observedEntity: "" }));
    expect(input).toEqual({
      sourceType: "app_store",
      rawText: "競合アプリが値上げした",
    });
  });

  it("rawText の改行を保持する（複数行の観測本文）", () => {
    const input = buildRawSignalInput(validFields({ rawText: "1行目\n2行目\n3行目" }));
    expect(input.rawText).toBe("1行目\n2行目\n3行目");
  });

  it("URL・観測対象・詳細項目は非空のときだけ含める", () => {
    const input = buildRawSignalInput(
      validFields({ country: "JP", observedPrice: "¥980", note: "メモ" }),
    );
    expect(input).toMatchObject({
      sourceType: "app_store",
      rawText: "競合アプリが値上げした",
      sourceUrl: "https://example.com/app",
      observedEntity: "Example App",
      country: "JP",
      observedPrice: "¥980",
      note: "メモ",
    });
  });
});

describe("QuickCapture: 検証（task-02 zod 経由）", () => {
  it("4 項目が揃えば ok で repository 入力を返す", () => {
    const result = validateQuickCapture(validFields());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.sourceType).toBe("app_store");
      expect(result.input.rawText).toBe("競合アプリが値上げした");
    }
  });

  it("rawText 未入力は送信不可・インラインエラー", () => {
    const result = validateQuickCapture(validFields({ rawText: "   " }));
    expect(result.ok).toBe(false);
    expect(result.errors.rawText).toBeTruthy();
  });

  it("sourceType 未選択は送信不可・インラインエラー", () => {
    const result = validateQuickCapture(validFields({ sourceType: "" }));
    expect(result.ok).toBe(false);
    expect(result.errors.sourceType).toBeTruthy();
  });
});

describe("QuickCapture: 送信", () => {
  it("4 項目入力→保存で API が呼ばれ Raw Signal が増える", async () => {
    const { store, fetcher } = makeFakeApi();
    expect(store).toHaveLength(0);

    const r1 = await submitRawSignal(validFields(), fetcher);
    expect(r1.ok).toBe(true);
    expect(store).toHaveLength(1);
    expect(store[0]).toMatchObject({
      sourceType: "app_store",
      rawText: "競合アプリが値上げした",
      sourceUrl: "https://example.com/app",
      observedEntity: "Example App",
    });

    // 連続入力: 2 件目も同じフォームから登録でき、件数が増える。
    const r2 = await submitRawSignal(validFields({ rawText: "別の観測" }), fetcher);
    expect(r2.ok).toBe(true);
    expect(store).toHaveLength(2);
  });

  it("必須未入力なら API を呼ばずインラインエラーを返す", async () => {
    const { store, fetcher } = makeFakeApi();
    const result = await submitRawSignal(validFields({ rawText: "" }), fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.rawText).toBeTruthy();
    }
    expect(store).toHaveLength(0);
  });

  it("API が失敗（!ok）ならインラインエラーを返す", async () => {
    const failing = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    const result = await submitRawSignal(validFields(), failing);
    expect(result.ok).toBe(false);
  });

  it("fetch が throw（通信エラー）してもインラインエラーに変換し、件数は増えない", async () => {
    const calls: number[] = [];
    const throwing = (async () => {
      calls.push(1);
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await submitRawSignal(validFields(), throwing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 入力保持のまま再試行案内（インラインエラー）。
      expect(result.errors.rawText).toBeTruthy();
    }
    expect(calls).toHaveLength(1);
  });
});

describe("QuickCapture: 連続入力", () => {
  it("保存後のクリアで 4 項目が空に戻る（フォーム継続）", () => {
    const cleared = emptyQuickCaptureFields();
    expect(cleared.sourceType).toBe("");
    expect(cleared.url).toBe("");
    expect(cleared.rawText).toBe("");
    expect(cleared.observedEntity).toBe("");
  });
});

describe("QuickCapture: 描画スモーク", () => {
  it("4 項目フォームと『詳細を追加』『保存』を描画する", () => {
    const html = renderToStaticMarkup(<QuickCapture />);
    expect(html).toContain("ソース種別");
    expect(html).toContain("本文");
    expect(html).toContain("URL");
    expect(html).toContain("観測対象");
    expect(html).toContain("詳細を追加");
    expect(html).toContain("保存して次へ");
    // 既定では詳細は閉じている（国フィールドは出さない）。
    expect(html).not.toContain("メモ");
    // sourceType セレクトに enum の選択肢が出る。
    expect(html).toContain('value="app_store"');
  });
});
