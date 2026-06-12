import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CandidateFilters,
  applyProductFormFitFilter,
  applyRiskFilter,
  buildCandidateListUrl,
  DEFAULT_SORT_BY,
  emptyCandidateQuery,
  fetchCandidates,
  SCORE_ONLY_SORT_KEYS,
  STAGE_FILTER_OPTIONS,
  TOP100_ENDPOINT,
  type CandidateQuery,
  type FetchedCandidate,
} from "../../components/candidate/CandidateFilters";
import {
  CandidateTable,
  candidateDetailHref,
  confidenceTone,
  formatConfidence,
  formatDistinctSources,
  formatScore,
  stageTone,
  truncate,
} from "../../components/candidate/CandidateTable";
import { STAGE_VALUES } from "../../lib/validation/enums";
import { createLatestGuard } from "../../app/candidates/page";

// task-20 Candidate 一覧（spec v2 §9.4）。
// テスト基盤に DOM/インタラクション依存は足さない方針のため、フィルタ→取得 URL の
// マッピング・取得（fetcher DI）・クライアント側フィルタ（リスク / ProductFormFit）・
// バッジ色・数値整形・既定ソート（スコア単独にしない）をロジックとして駆動して受入
// 基準を検証し、描画は react-dom/server の静的描画で確認する。

/** 一覧 1 行のダミー（API の返す形）。 */
function row(overrides: Partial<FetchedCandidate> = {}): FetchedCandidate {
  return {
    id: "c1",
    displayId: "CND-001",
    title: "競合より安い請求書アプリ",
    targetUser: "個人事業主",
    problemFamily: "請求・経理",
    stage: "normalized",
    initialScore: 3.2,
    detailedScore: null,
    confidence: 0.7,
    distinctSources: 2,
    nextAction: "スモークテスト設計",
    legalRisk: 1,
    opsRisk: 0,
    productFormFit: ["mobile", "automation"],
    ...overrides,
  };
}

/** 一覧 API を受ける擬似 fetch。最後に呼ばれた URL を記録する。 */
function makeFakeApi(data: FetchedCandidate[]) {
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

describe("CandidateFilters: 既定ソートはスコア単独にしない（§9.4 過信防止）", () => {
  it("既定ソート軸はスコア単独軸でなく updatedAt", () => {
    expect(DEFAULT_SORT_BY).toBe("updatedAt");
    expect(SCORE_ONLY_SORT_KEYS).not.toContain(DEFAULT_SORT_BY);
    expect(emptyCandidateQuery().sortBy).toBe(DEFAULT_SORT_BY);
  });

  it("stage の選択肢は task-02 の enum＋『すべて』空 option", () => {
    expect(STAGE_FILTER_OPTIONS[0].value).toBe("");
    expect(STAGE_FILTER_OPTIONS.slice(1).map((o) => o.value)).toEqual([...STAGE_VALUES]);
  });
});

describe("buildCandidateListUrl: フィルタが取得 URL に反映される", () => {
  it("既定（all ビュー・空フィルタ）は sortBy=updatedAt のみ", () => {
    expect(buildCandidateListUrl(emptyCandidateQuery())).toBe("/api/candidates?sortBy=updatedAt");
  });

  it("stage / minEvidence / sortBy をクエリへマップする", () => {
    const url = buildCandidateListUrl({
      ...emptyCandidateQuery(),
      stage: "top100",
      minEvidence: "3",
      sortBy: "confidence",
    });
    const params = new URL(url, "http://x").searchParams;
    expect(params.get("stage")).toBe("top100");
    expect(params.get("minEvidence")).toBe("3");
    expect(params.get("sortBy")).toBe("confidence");
  });

  it("リスク・ProductFormFit はサーバへ送らない（クライアント側で適用）", () => {
    const url = buildCandidateListUrl({
      ...emptyCandidateQuery(),
      maxRisk: "2",
      productFormFit: "mobile",
    });
    const params = new URL(url, "http://x").searchParams;
    expect(params.has("maxRisk")).toBe(false);
    expect(params.has("productFormFit")).toBe(false);
  });

  it("Top100 ビューはゲート判定 API を使う（サーバパラメータなし）", () => {
    expect(
      buildCandidateListUrl({ ...emptyCandidateQuery(), view: "top100", stage: "top30" }),
    ).toBe(TOP100_ENDPOINT);
  });
});

describe("applyRiskFilter: リスク上限はクライアント側で絞り込む", () => {
  const rows = [
    row({ id: "a", legalRisk: 1, opsRisk: 0 }),
    row({ id: "b", legalRisk: 3, opsRisk: 1 }),
    row({ id: "c", legalRisk: null, opsRisk: null }),
  ];

  it("空は全件素通し", () => {
    expect(applyRiskFilter(rows, "").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("legalRisk / opsRisk の最大が上限以下のみ残す（null は 0 扱い）", () => {
    expect(applyRiskFilter(rows, "1").map((r) => r.id)).toEqual(["a", "c"]);
    expect(applyRiskFilter(rows, "3").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("applyProductFormFitFilter: ProductFormFit はクライアント側で絞り込む", () => {
  const rows = [
    row({ id: "a", productFormFit: ["mobile", "automation"] }),
    row({ id: "b", productFormFit: ["web"] }),
    row({ id: "c", productFormFit: [] }),
  ];

  it("空は全件素通し", () => {
    expect(applyProductFormFitFilter(rows, "").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("大文字小文字を無視して contains で絞り込む", () => {
    expect(applyProductFormFitFilter(rows, "MOB").map((r) => r.id)).toEqual(["a"]);
    expect(applyProductFormFitFilter(rows, "we").map((r) => r.id)).toEqual(["b"]);
  });
});

describe("fetchCandidates: 取得（fetcher DI）", () => {
  it("all ビューは組み立てた URL で取得し data を返す", async () => {
    const { calls, fetcher } = makeFakeApi([row()]);
    const result = await fetchCandidates({ ...emptyCandidateQuery(), stage: "top100" }, fetcher);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("stage=top100");
    expect(calls[0]).toContain("sortBy=updatedAt");
    expect(result).toHaveLength(1);
    expect(result[0].displayId).toBe("CND-001");
  });

  it("Top100 ビューはゲート判定 API を叩く", async () => {
    const { calls, fetcher } = makeFakeApi([row()]);
    await fetchCandidates({ ...emptyCandidateQuery(), view: "top100" }, fetcher);
    expect(calls[0]).toBe(TOP100_ENDPOINT);
  });

  it("取得後にリスク・ProductFormFit をクライアント側で適用する", async () => {
    const { fetcher } = makeFakeApi([
      row({ id: "a", legalRisk: 1, opsRisk: 0, productFormFit: ["mobile"] }),
      row({ id: "b", legalRisk: 4, opsRisk: 0, productFormFit: ["mobile"] }),
      row({ id: "c", legalRisk: 0, opsRisk: 0, productFormFit: ["web"] }),
    ]);
    const result = await fetchCandidates(
      { ...emptyCandidateQuery(), maxRisk: "2", productFormFit: "mobile" },
      fetcher,
    );
    expect(result.map((r) => r.id)).toEqual(["a"]);
  });

  it("!ok なら例外を投げる", async () => {
    const failing = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchCandidates(emptyCandidateQuery(), failing)).rejects.toThrow();
  });
});

describe("createLatestGuard: 古いレスポンスの後着を破棄する", () => {
  it("後から始めた新リクエストのトークンだけが current", () => {
    const guard = createLatestGuard();
    const t1 = guard.next();
    const t2 = guard.next();
    expect(guard.isCurrent(t1)).toBe(false);
    expect(guard.isCurrent(t2)).toBe(true);
  });

  it("応答の到着順が逆転しても最新クエリの結果のみが採用される", async () => {
    const guard = createLatestGuard();
    const applied: string[] = [];

    const t1 = guard.next();
    const slow = Promise.resolve("old");
    const t2 = guard.next();
    const fast = Promise.resolve("new");

    const r2 = await fast;
    if (guard.isCurrent(t2)) applied.push(r2);
    const r1 = await slow;
    if (guard.isCurrent(t1)) applied.push(r1);

    expect(applied).toEqual(["new"]);
  });
});

describe("CandidateTable: バッジ色・整形・導線", () => {
  it("stage / confidence のバッジ色は未知/未設定で neutral にフォールバック", () => {
    expect(stageTone("top100")).toBe("info");
    expect(stageTone("focus")).toBe("success");
    expect(stageTone("rejected")).toBe("danger");
    expect(stageTone("???")).toBe("neutral");
    expect(confidenceTone(0.8)).toBe("success");
    expect(confidenceTone(0.4)).toBe("info");
    expect(confidenceTone(0.1)).toBe("warning");
    expect(confidenceTone(null)).toBe("neutral");
  });

  it("スコア・確信度・distinctSources を整形し、未設定は『—』", () => {
    expect(formatScore(3.2)).toBe("3.2");
    expect(formatScore(null)).toBe("—");
    expect(formatConfidence(0.7)).toBe("0.70");
    expect(formatConfidence(null)).toBe("—");
    expect(formatDistinctSources(2)).toBe("2");
    expect(formatDistinctSources(null)).toBe("—");
    expect(truncate("a".repeat(50)).endsWith("…")).toBe(true);
    expect(truncate("短い")).toBe("短い");
  });

  it("行導線は詳細(編集)の href を持つ", () => {
    expect(candidateDetailHref("c1")).toBe("/candidates/c1");
  });
});

describe("CandidateTable: 描画", () => {
  it("§9.4 のカラム・バッジ・行導線を描画する", () => {
    const html = renderToStaticMarkup(<CandidateTable rows={[row()]} />);
    // カラム見出し（§9.4）
    expect(html).toContain("ID");
    expect(html).toContain("タイトル");
    expect(html).toContain("対象ユーザー");
    expect(html).toContain("課題ファミリ");
    expect(html).toContain("stage");
    expect(html).toContain("初期スコア");
    expect(html).toContain("詳細スコア");
    expect(html).toContain("確信度");
    expect(html).toContain("ソース種別数");
    expect(html).toContain("次アクション");
    // セル内容（confidence と distinctSources が表示される＝受入基準）
    expect(html).toContain("CND-001");
    expect(html).toContain("競合より安い請求書アプリ");
    expect(html).toContain("0.70");
    expect(html).toContain("mi-badge");
    expect(html).toContain('href="/candidates/c1"');
  });

  it("空のときは空メッセージを出す", () => {
    const html = renderToStaticMarkup(<CandidateTable rows={[]} />);
    expect(html).toContain("Candidate がありません");
  });
});

describe("CandidateFilters: 描画", () => {
  it("ビュー切替・stage・Evidence 数・リスク・ProductFormFit・並び替えを描画する", () => {
    const value: CandidateQuery = emptyCandidateQuery();
    const html = renderToStaticMarkup(<CandidateFilters value={value} onChange={() => {}} />);
    expect(html).toContain("ビュー");
    expect(html).toContain("stage");
    expect(html).toContain("Evidence 数");
    expect(html).toContain("リスク上限");
    expect(html).toContain("ProductFormFit");
    expect(html).toContain("並び替え");
    // Top100 ビュー切替と enum の stage 選択肢が出る。
    expect(html).toContain("Top100");
    expect(html).toContain('value="normalized"');
  });
});
