import { describe, expect, it } from "vitest";

import { scoringConfig, type ScoringConfig } from "../../lib/scoring/config";
import {
  detailedScore,
  signalBonus,
  totalForGate,
  uncertaintyPenalty,
  type DetailedInputs,
} from "../../lib/scoring/detailedScore";

// task-26 acceptance criteria (spec v2 §8.4-8.5):
// - 各軸満点で 100、全0で 0
// - 入力スケール（axis/5*weight）の代表ケース検証
// - SignalBonus の境界（1/2/3/4・支出有無）テスト
// - totalForGate の合成テスト
// - 純粋関数 / config 経由（重み外部化）

// 既定 detailedWeights（§8.4 正本・合計100）:
// spend15 / wtp10 / acquisition10 / pain10 / frequency8 / retention8 /
// competitorPain8 / differentiation8 / formFit7 / pfFit6 / buildEase5 / legalSafety5

const maxInputs: DetailedInputs = {
  spend: 5,
  wtp: 5,
  acquisition: 5,
  pain: 5,
  frequency: 5,
  retention: 5,
  competitorPain: 5,
  differentiation: 5,
  formFit: 5,
  pfFit: 5,
  buildEase: 5,
  legalSafety: 5,
};

const zeroInputs: DetailedInputs = {
  spend: 0,
  wtp: 0,
  acquisition: 0,
  pain: 0,
  frequency: 0,
  retention: 0,
  competitorPain: 0,
  differentiation: 0,
  formFit: 0,
  pfFit: 0,
  buildEase: 0,
  legalSafety: 0,
};

describe("detailedScore", () => {
  it("returns 100 when every axis is maxed (weights sum to 100)", () => {
    // 各軸 5/5=1 → Σ weight = 15+10+10+10+8+8+8+8+7+6+5+5 = 100
    expect(detailedScore(maxInputs, scoringConfig)).toBe(100);
  });

  it("returns 0 when every axis is zero", () => {
    expect(detailedScore(zeroInputs, scoringConfig)).toBe(0);
  });

  it("applies the axis/5 * weight scale for a single axis (half score → half weight)", () => {
    // spend のみ素点 3 → (3/5)*15 = 9
    expect(detailedScore({ ...zeroInputs, spend: 3 }, scoringConfig)).toBeCloseTo(9, 10);
    // legalSafety のみ素点 4 → (4/5)*5 = 4
    expect(detailedScore({ ...zeroInputs, legalSafety: 4 }, scoringConfig)).toBeCloseTo(4, 10);
  });

  it("computes a representative mixed case (hand-calculated)", () => {
    const inputs: DetailedInputs = {
      spend: 5, //   (5/5)*15 = 15
      wtp: 4, //     (4/5)*10 = 8
      acquisition: 3, // (3/5)*10 = 6
      pain: 5, //    (5/5)*10 = 10
      frequency: 0, // 0
      retention: 0, // 0
      competitorPain: 0, // 0
      differentiation: 0, // 0
      formFit: 0, // 0
      pfFit: 0, // 0
      buildEase: 0, // 0
      legalSafety: 5, // (5/5)*5 = 5
    };
    // 15+8+6+10+5 = 44
    expect(detailedScore(inputs, scoringConfig)).toBeCloseTo(44, 10);
  });

  it("weights Spend highest among the axes (1 point of spend > 1 point of buildEase)", () => {
    const onlySpend = detailedScore({ ...zeroInputs, spend: 1 }, scoringConfig);
    const onlyBuildEase = detailedScore({ ...zeroInputs, buildEase: 1 }, scoringConfig);
    expect(onlySpend).toBeCloseTo((1 / 5) * 15, 10); // 3
    expect(onlyBuildEase).toBeCloseTo((1 / 5) * 5, 10); // 1
    expect(onlySpend).toBeGreaterThan(onlyBuildEase);
  });

  it("changes the result when config weights are swapped (weights are externalized)", () => {
    // 全 detailedWeights を 1 にすると、最大は (5/5)*1*12 = 12。
    const unitWeightConfig: ScoringConfig = {
      ...scoringConfig,
      detailedWeights: {
        spend: 1,
        wtp: 1,
        acquisition: 1,
        pain: 1,
        frequency: 1,
        retention: 1,
        competitorPain: 1,
        differentiation: 1,
        formFit: 1,
        pfFit: 1,
        buildEase: 1,
        legalSafety: 1,
      },
    };
    expect(detailedScore(maxInputs, unitWeightConfig)).toBeCloseTo(12, 10);
    expect(detailedScore(maxInputs, unitWeightConfig)).not.toBe(
      detailedScore(maxInputs, scoringConfig),
    );
  });

  it("is a pure function (same input → same output, no side effects)", () => {
    const frozen = Object.freeze({ ...maxInputs });
    const first = detailedScore(frozen, scoringConfig);
    const second = detailedScore(frozen, scoringConfig);
    expect(first).toBe(second);
    expect(frozen).toEqual(maxInputs);
  });
});

describe("signalBonus", () => {
  it("gives +0 for a single source", () => {
    expect(signalBonus(1, false, scoringConfig)).toBe(0);
    expect(signalBonus(1, true, scoringConfig)).toBe(0);
    expect(signalBonus(0, true, scoringConfig)).toBe(0);
  });

  it("gives +5 for two distinct sources (default config)", () => {
    expect(signalBonus(2, false, scoringConfig)).toBe(5);
    expect(signalBonus(2, true, scoringConfig)).toBe(5);
  });

  it("gives +10 for three distinct sources (default config)", () => {
    expect(signalBonus(3, false, scoringConfig)).toBe(10);
    expect(signalBonus(3, true, scoringConfig)).toBe(10);
  });

  it("gives +15 for four-plus distinct sources WITH spend evidence", () => {
    expect(signalBonus(4, true, scoringConfig)).toBe(15);
    expect(signalBonus(7, true, scoringConfig)).toBe(15);
  });

  it("caps four-plus sources WITHOUT spend at the 3-source bonus (+10)", () => {
    // 支出証拠がなければプレミアム(+15)は付かず3ソース相当に留まる（§8.5: 4+ かつ 支出証拠あり）
    expect(signalBonus(4, false, scoringConfig)).toBe(10);
    expect(signalBonus(9, false, scoringConfig)).toBe(10);
  });

  it("reads bonus amounts from config (externalized)", () => {
    const doubled: ScoringConfig = {
      ...scoringConfig,
      signalBonus: { "2": 10, "3": 20, "4plusWithSpend": 30 },
    };
    expect(signalBonus(2, false, doubled)).toBe(10);
    expect(signalBonus(3, false, doubled)).toBe(20);
    expect(signalBonus(4, true, doubled)).toBe(30);
  });
});

describe("uncertaintyPenalty", () => {
  it("returns 0 / 5 / 10 for enough / mixed / unconfirmed (§8.5)", () => {
    expect(uncertaintyPenalty("enough")).toBe(0);
    expect(uncertaintyPenalty("mixed")).toBe(5);
    expect(uncertaintyPenalty("unconfirmed")).toBe(10);
  });
});

describe("totalForGate", () => {
  it("composes DetailedScore + SignalBonus - UncertaintyPenalty (§8.4)", () => {
    // detailed 44 + bonus 10 - penalty 5 = 49
    expect(totalForGate(44, 10, 5)).toBe(49);
  });

  it("composes from the three pure functions end-to-end", () => {
    const inputs: DetailedInputs = {
      spend: 5,
      wtp: 4,
      acquisition: 3,
      pain: 5,
      frequency: 0,
      retention: 0,
      competitorPain: 0,
      differentiation: 0,
      formFit: 0,
      pfFit: 0,
      buildEase: 0,
      legalSafety: 5,
    };
    const detailed = detailedScore(inputs, scoringConfig); // 44
    const bonus = signalBonus(4, true, scoringConfig); // 15
    const penalty = uncertaintyPenalty("mixed"); // 5
    // 44 + 15 - 5 = 54
    expect(totalForGate(detailed, bonus, penalty)).toBeCloseTo(54, 10);
  });

  it("subtracts the uncertainty penalty (higher uncertainty → lower total)", () => {
    const enough = totalForGate(80, 10, uncertaintyPenalty("enough"));
    const unconfirmed = totalForGate(80, 10, uncertaintyPenalty("unconfirmed"));
    expect(enough).toBe(90);
    expect(unconfirmed).toBe(80);
    expect(unconfirmed).toBeLessThan(enough);
  });
});
