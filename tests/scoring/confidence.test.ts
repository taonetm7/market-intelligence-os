import { describe, expect, it } from "vitest";

import { computeConfidence, type ConfidenceInputs } from "../../lib/scoring/confidence";

// task-06 acceptance criteria (spec v2 §8.6):
// - 最強ケース（distinct≥3, strength=5, spend=1, recency=1）で 1.0
// - ゼロケースで 0.0
// - 各項の寄与（0.4 / 0.3 / 0.2 / 0.1）を個別検証
// - 出力が常に [0,1] に収まる（境界クランプ）
// - 純粋関数（同入力→同出力・副作用なし）
//
// 式: 0.4*min(distinctSourceTypes/3,1) + 0.3*(avgEvidenceStrength/5)
//     + 0.2*hasDirectSpendEvidence + 0.1*recencyFactor

// すべての項が 0 になる基準ケース（ここから1項ずつ立てて寄与を確認する）。
const zeroInputs: ConfidenceInputs = {
  distinctSourceTypes: 0,
  avgEvidenceStrength: 0,
  hasDirectSpendEvidence: 0,
  recencyFactor: 0,
};

describe("computeConfidence", () => {
  it("returns 1.0 for the strongest case (distinct≥3, strength=5, spend=1, recency=1)", () => {
    const result = computeConfidence({
      distinctSourceTypes: 3,
      avgEvidenceStrength: 5,
      hasDirectSpendEvidence: 1,
      recencyFactor: 1,
    });
    expect(result).toBeCloseTo(1.0, 10);
  });

  it("returns 0.0 for the zero case (every observation absent)", () => {
    expect(computeConfidence(zeroInputs)).toBeCloseTo(0.0, 10);
  });

  it("contributes 0.4 from distinct source types alone (distinct=3)", () => {
    expect(computeConfidence({ ...zeroInputs, distinctSourceTypes: 3 })).toBeCloseTo(0.4, 10);
  });

  it("contributes 0.3 from average evidence strength alone (strength=5)", () => {
    expect(computeConfidence({ ...zeroInputs, avgEvidenceStrength: 5 })).toBeCloseTo(0.3, 10);
  });

  it("contributes 0.2 from direct spend evidence alone (spend=1)", () => {
    expect(computeConfidence({ ...zeroInputs, hasDirectSpendEvidence: 1 })).toBeCloseTo(0.2, 10);
  });

  it("contributes 0.1 from recency alone (recency=1)", () => {
    expect(computeConfidence({ ...zeroInputs, recencyFactor: 1 })).toBeCloseTo(0.1, 10);
  });

  it("scales each term linearly between 0 and its weight", () => {
    // distinct=1.5/3=0.5 → 0.2, strength=2.5/5=0.5 → 0.15, recency=0.5 → 0.05。
    expect(
      computeConfidence({
        distinctSourceTypes: 1.5,
        avgEvidenceStrength: 2.5,
        hasDirectSpendEvidence: 0,
        recencyFactor: 0.5,
      }),
    ).toBeCloseTo(0.2 + 0.15 + 0.05, 10);
  });

  it("saturates the distinct-source term at 3 (min(.../3, 1))", () => {
    // distinct=3 と distinct=6 はどちらも寄与 0.4 で頭打ち。
    expect(computeConfidence({ ...zeroInputs, distinctSourceTypes: 6 })).toBeCloseTo(0.4, 10);
    expect(computeConfidence({ ...zeroInputs, distinctSourceTypes: 100 })).toBeCloseTo(0.4, 10);
  });

  it("never exceeds 1 even when inputs overflow their nominal range", () => {
    const result = computeConfidence({
      distinctSourceTypes: 999,
      avgEvidenceStrength: 50,
      hasDirectSpendEvidence: 1,
      recencyFactor: 9,
    });
    expect(result).toBeLessThanOrEqual(1);
    expect(result).toBeCloseTo(1.0, 10);
  });

  it("never drops below 0 even when inputs are negative", () => {
    const result = computeConfidence({
      distinctSourceTypes: -5,
      avgEvidenceStrength: -3,
      hasDirectSpendEvidence: 0,
      recencyFactor: -2,
    });
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeCloseTo(0.0, 10);
  });

  it("is a pure function (same input → same output, no mutation)", () => {
    const inputs: ConfidenceInputs = Object.freeze({
      distinctSourceTypes: 2,
      avgEvidenceStrength: 4,
      hasDirectSpendEvidence: 1,
      recencyFactor: 0.7,
    });
    const first = computeConfidence(inputs);
    const second = computeConfidence(inputs);
    expect(first).toBe(second);
    // 入力オブジェクトが変更されていない（副作用なし）。
    expect(inputs).toEqual({
      distinctSourceTypes: 2,
      avgEvidenceStrength: 4,
      hasDirectSpendEvidence: 1,
      recencyFactor: 0.7,
    });
  });
});
