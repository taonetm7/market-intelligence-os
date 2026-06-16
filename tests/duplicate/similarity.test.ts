import { describe, expect, it } from "vitest";

import {
  DEFAULT_THRESHOLD,
  normalizeText,
  similarity,
  tagSimilarity,
  textSimilarity,
  type CandidateFeatures,
} from "../../lib/duplicate/similarity";

// task-34 — Candidate 類似度（重複検出の素性）。spec v2 §9.7 / §3.3。
// 純粋関数の単体テスト: 同一 / 部分一致 / 無関係 を中心に、テキスト・タグ・加重和・一致理由を検証。
// import は相対パス（@/ は vitest 非対応）。

/** §9.7 全項目を埋めた基準候補（ここから差分を与えて比較する）。 */
function features(overrides: Partial<CandidateFeatures> = {}): CandidateFeatures {
  return {
    problemFamily: "請求書の作成と送付",
    targetUser: "個人事業主",
    contextTrigger: "月末の締め作業",
    painStatement: "毎月手作業で請求書を作るのが面倒",
    currentSubstitute: "Excel テンプレート",
    tags: ["invoicing", "automation"],
    ...overrides,
  };
}

describe("normalizeText", () => {
  it("全角/大小文字/余分な空白を畳む（NFKC・小文字化・空白正規化）", () => {
    expect(normalizeText("  Ｈｅｌｌｏ   World  ")).toBe("hello world");
    expect(normalizeText("ＡＢＣ")).toBe("abc");
  });

  it("空・空白のみは空文字", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText("   ")).toBe("");
  });
});

describe("textSimilarity", () => {
  it("完全一致は 1.0（正規化後に一致）", () => {
    expect(textSimilarity("請求書の作成", "請求書の作成")).toBe(1);
    expect(textSimilarity("Hello World", "  hello   world ")).toBe(1);
  });

  it("部分一致は 0 と 1 の間", () => {
    const sim = textSimilarity("請求書の作成と送付", "請求書の作成");
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it("無関係は低い（0 に近い）", () => {
    expect(textSimilarity("請求書の作成", "天気予報アプリ")).toBeLessThan(0.2);
  });

  it("両方空は 0", () => {
    expect(textSimilarity("", "")).toBe(0);
    expect(textSimilarity(null, null)).toBe(0);
  });

  it("片側だけ内容ありは 0", () => {
    expect(textSimilarity("請求書", "")).toBe(0);
    expect(textSimilarity(null, "請求書")).toBe(0);
  });
});

describe("tagSimilarity", () => {
  it("同一タグ集合は 1.0（順序・大小文字・重複を無視）", () => {
    expect(tagSimilarity(["A", "B"], ["b", "a", "a"])).toBe(1);
  });

  it("一部重複は Jaccard（{a,b} と {b,c} → 1/3）", () => {
    expect(tagSimilarity(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 10);
  });

  it("重複なしは 0、両方空も 0", () => {
    expect(tagSimilarity(["a"], ["b"])).toBe(0);
    expect(tagSimilarity([], [])).toBe(0);
  });
});

describe("similarity（加重和・一致理由）", () => {
  it("同一候補はスコア 1.0 で全項目が一致理由に挙がる", () => {
    const result = similarity(features(), features());
    expect(result.score).toBeCloseTo(1, 10);
    // テキスト 5 項目 ＋ tags の計 6 項目すべてが一致（類似度 1）。
    expect(result.matched).toHaveLength(6);
    expect(result.matched.every((m) => m.similarity === 1)).toBe(true);
  });

  it("部分一致は閾値以上で、一致した項目だけが理由に並ぶ", () => {
    // problemFamily / painStatement は近い、targetUser ほかは別物にする。
    const a = features();
    const b = features({
      targetUser: "大企業の経理部門",
      contextTrigger: "監査対応",
      currentSubstitute: "基幹システム",
      tags: ["accounting"],
    });
    const result = similarity(a, b);
    expect(result.score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
    expect(result.score).toBeLessThan(1);
    // problemFamily / painStatement は一致理由に含まれる。
    const fields = result.matched.map((m) => m.field);
    expect(fields).toContain("problemFamily");
    expect(fields).toContain("painStatement");
    // 一致理由は類似度降順。
    const sims = result.matched.map((m) => m.similarity);
    expect([...sims].sort((x, y) => y - x)).toEqual(sims);
  });

  it("無関係な候補は閾値未満・一致理由なし", () => {
    const a = features();
    const b: CandidateFeatures = {
      problemFamily: "観光地の混雑予測",
      targetUser: "自治体の観光課",
      contextTrigger: "大型連休",
      painStatement: "人出が読めず人員配置に失敗する",
      currentSubstitute: "過去の勘",
      tags: ["tourism", "forecast"],
    };
    const result = similarity(a, b);
    expect(result.score).toBeLessThan(DEFAULT_THRESHOLD);
    expect(result.matched).toEqual([]);
  });

  it("両側とも空の項目は分母から除外する（情報のない項目で薄めない）", () => {
    // problemFamily だけ完全一致、他のテキストと tags は両側空 → スコアは 1.0 になる。
    const sparse: CandidateFeatures = {
      problemFamily: "請求書の作成",
      targetUser: null,
      contextTrigger: null,
      painStatement: null,
      currentSubstitute: null,
      tags: [],
    };
    const result = similarity(sparse, { ...sparse });
    expect(result.score).toBeCloseTo(1, 10);
    expect(result.matched).toEqual([{ field: "problemFamily", similarity: 1 }]);
  });

  it("全項目が空同士はスコア 0（比較材料なし）", () => {
    const empty: CandidateFeatures = {
      problemFamily: null,
      targetUser: null,
      contextTrigger: null,
      painStatement: null,
      currentSubstitute: null,
      tags: [],
    };
    const result = similarity(empty, empty);
    expect(result.score).toBe(0);
    expect(result.matched).toEqual([]);
  });

  it("重みを変えると加重和が変わる", () => {
    const a = features();
    const b = features({ painStatement: "全く違う痛みの記述テキスト" });
    const base = similarity(a, b).score;
    // painStatement の重みを 0 にすれば、その（低い）類似度の影響が消えてスコアが上がる。
    const weighted = similarity(a, b, {
      problemFamily: 3,
      painStatement: 0,
      targetUser: 2,
      contextTrigger: 2,
      currentSubstitute: 2,
      tags: 2,
    }).score;
    expect(weighted).toBeGreaterThan(base);
  });
});
