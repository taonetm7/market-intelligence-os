import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DUPLICATES_ENDPOINT,
  buildDuplicatesUrl,
  fetchDuplicatePairs,
  isRefetchAction,
  visiblePairs,
} from "../../app/duplicates/page";
import {
  COMPARISON_FIELDS,
  DuplicatePairCard,
  FEATURE_LABELS,
  defaultMergeReason,
  defaultSplitReason,
  formatScorePct,
  matchedFieldSet,
  pairKey,
  resolveMergeIds,
  type DuplicateCandidateView,
  type DuplicatePairView,
} from "../../components/duplicate/DuplicatePairCard";
import {
  mergeEndpoint,
  splitEndpoint,
  submitMerge,
  submitSplit,
} from "../../components/candidate/MergeSplitDialog";
import { stageSchema } from "../../lib/validation/enums";

// task-35 — Duplicate Review UI（spec v2 §9.7）。
// 既存 UI と同じ方針: DOM/インタラクション依存は足さず、取得（fetcher DI）・抑制・一致理由・
// merge/split の API 委譲をロジックとして駆動し、描画は react-dom/server の静的描画で検証する。
// import は相対パス（@/ は vitest 非対応）。

function candidate(overrides: Partial<DuplicateCandidateView> = {}): DuplicateCandidateView {
  return {
    id: "c-a",
    displayId: "CND-001",
    title: "請求書作成アプリ",
    problemFamily: "請求書の作成と送付",
    targetUser: "個人事業主",
    contextTrigger: "月末の締め作業",
    painStatement: "毎月手作業で請求書を作るのが面倒",
    currentSubstitute: "Excel テンプレート",
    stage: stageSchema.enum.normalized,
    ...overrides,
  };
}

function pairFixture(overrides: Partial<DuplicatePairView> = {}): DuplicatePairView {
  return {
    a: candidate({ id: "c-a", displayId: "CND-001", title: "請求書作成アプリ" }),
    b: candidate({ id: "c-b", displayId: "CND-002", title: "インボイス自動化" }),
    score: 0.8,
    matched: [
      { field: "problemFamily", similarity: 1 },
      { field: "painStatement", similarity: 0.7 },
    ],
    ...overrides,
  };
}

/** 一覧 API を受ける擬似 fetch。呼ばれた URL を記録する。 */
function makeListApi(data: DuplicatePairView[]) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

/** merge / split を受ける擬似 fetch。URL と body を記録し ok を返す。 */
function recordingApi() {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, status: 200, json: async () => ({ data: { ok: true } }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe("buildDuplicatesUrl / fetchDuplicatePairs: 取得経路", () => {
  it("クエリ無しは素のエンドポイント", () => {
    expect(buildDuplicatesUrl()).toBe(DUPLICATES_ENDPOINT);
  });

  it("threshold / limit をクエリへマップする", () => {
    const url = buildDuplicatesUrl({ threshold: 0.6, limit: 5 });
    const params = new URL(url, "http://x").searchParams;
    expect(params.get("threshold")).toBe("0.6");
    expect(params.get("limit")).toBe("5");
  });

  it("エンドポイントで取得し data を返す（fetcher DI）", async () => {
    const { calls, fetcher } = makeListApi([pairFixture()]);
    const result = await fetchDuplicatePairs({}, fetcher);
    expect(calls[0]).toBe(DUPLICATES_ENDPOINT);
    expect(result).toHaveLength(1);
    expect(result[0].a.displayId).toBe("CND-001");
  });

  it("!ok なら例外を投げる", async () => {
    const failing = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchDuplicatePairs({}, failing)).rejects.toThrow();
  });
});

describe("pairKey / visiblePairs: Keep Separate・Not Duplicate でペアが除外される", () => {
  it("pairKey は左右の順序に依らない（同じ 2 候補は同じキー）", () => {
    const ab = pairFixture();
    const ba = pairFixture({ a: ab.b, b: ab.a });
    expect(pairKey(ab)).toBe(pairKey(ba));
  });

  it("抑制集合に入れたペアは表示対象から外れる", () => {
    const keep = pairFixture({ a: candidate({ id: "k-a", displayId: "CND-010" }), b: candidate({ id: "k-b", displayId: "CND-011" }) });
    const other = pairFixture({ a: candidate({ id: "o-a", displayId: "CND-020" }), b: candidate({ id: "o-b", displayId: "CND-021" }) });
    const dismissed = new Set([pairKey(keep)]);
    const visible = visiblePairs([keep, other], dismissed);
    expect(visible.map(pairKey)).toEqual([pairKey(other)]);
  });
});

describe("isRefetchAction: Merge/Split は一覧を取り直す", () => {
  it("merge / split は再取得・keep_separate / not_duplicate は再取得しない", () => {
    expect(isRefetchAction("merge")).toBe(true);
    expect(isRefetchAction("split")).toBe(true);
    expect(isRefetchAction("keep_separate")).toBe(false);
    expect(isRefetchAction("not_duplicate")).toBe(false);
  });
});

describe("一致理由・survivor 解決・整形", () => {
  it("matchedFieldSet は一致した素性キーの集合", () => {
    const set = matchedFieldSet(pairFixture().matched);
    expect(set.has("problemFamily")).toBe(true);
    expect(set.has("painStatement")).toBe(true);
    expect(set.has("targetUser")).toBe(false);
  });

  it("formatScorePct は百分率整数表記", () => {
    expect(formatScorePct(0.8)).toBe("80%");
    expect(formatScorePct(1)).toBe("100%");
  });

  it("resolveMergeIds は survivor 側の選択で生存 / 吸収 ID を入れ替える", () => {
    const pair = pairFixture();
    expect(resolveMergeIds(pair, "a")).toEqual({ survivorId: "c-a", absorbedId: "c-b" });
    expect(resolveMergeIds(pair, "b")).toEqual({ survivorId: "c-b", absorbedId: "c-a" });
  });

  it("既定理由は非空で両候補の displayId を含む（API の必須を満たす）", () => {
    const pair = pairFixture();
    const reason = defaultMergeReason(pair.a, pair.b);
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toContain("CND-001");
    expect(reason).toContain("CND-002");
    expect(defaultSplitReason(pair.a).length).toBeGreaterThan(0);
  });

  it("COMPARISON_FIELDS は §9.7 のテキスト 5 項目（tags は含めない）", () => {
    expect(COMPARISON_FIELDS.map((f) => f.key)).toEqual([
      "problemFamily",
      "painStatement",
      "targetUser",
      "contextTrigger",
      "currentSubstitute",
    ]);
    expect(FEATURE_LABELS.tags).toBeDefined();
  });
});

describe("Merge / Split は task-30 API 経由で実行される（fetcher DI）", () => {
  it("submitMerge は survivor の merge エンドポイントへ absorbedId / reason を POST", async () => {
    const pair = pairFixture();
    const { survivorId, absorbedId } = resolveMergeIds(pair, "a");
    const { calls, fetcher } = recordingApi();
    await submitMerge(survivorId, { absorbedId, reason: defaultMergeReason(pair.a, pair.b) }, fetcher);
    expect(calls[0].url).toBe(mergeEndpoint("c-a"));
    expect(calls[0].body).toMatchObject({ absorbedId: "c-b" });
    expect((calls[0].body as { reason: string }).reason.length).toBeGreaterThan(0);
  });

  it("submitSplit は対象候補の split エンドポイントへ reason を POST", async () => {
    const pair = pairFixture();
    const { calls, fetcher } = recordingApi();
    await submitSplit(pair.a.id, { evidenceIds: [], reason: defaultSplitReason(pair.a) }, fetcher);
    expect(calls[0].url).toBe(splitEndpoint("c-a"));
    expect((calls[0].body as { reason: string }).reason.length).toBeGreaterThan(0);
  });
});

describe("DuplicatePairCard: 描画（並べて差分＋一致理由＋操作）", () => {
  const html = renderToStaticMarkup(
    <DuplicatePairCard pair={pairFixture()} onResolved={() => {}} />,
  );

  it("2 候補を左右に並べて表示する", () => {
    expect(html).toContain("CND-001");
    expect(html).toContain("請求書作成アプリ");
    expect(html).toContain("CND-002");
    expect(html).toContain("インボイス自動化");
  });

  it("一致理由（matched の項目ラベル）を表示する", () => {
    expect(html).toContain("一致理由");
    expect(html).toContain(FEATURE_LABELS.problemFamily);
    expect(html).toContain(FEATURE_LABELS.painStatement);
  });

  it("一致した項目をハイライトする（一致バッジ）", () => {
    expect(html).toContain("mi-dup-match");
  });

  it("Merge / Split / Keep Separate / Not Duplicate の操作と survivor 選択を出す", () => {
    expect(html).toContain("統合（Merge）");
    expect(html).toContain("分割（Split）");
    expect(html).toContain("別物として残す（Keep Separate）");
    expect(html).toContain("重複でない（Not Duplicate）");
    expect(html).toContain("survivor");
    expect(html).toContain('type="radio"');
  });

  it("類似度スコアを百分率で表示する", () => {
    expect(html).toContain("80%");
  });
});
