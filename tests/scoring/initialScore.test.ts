import { describe, expect, it } from "vitest";

import { scoringConfig, type ScoringConfig } from "../../lib/scoring/config";
import { computeInitialScore, type InitialInputs } from "../../lib/scoring/initialScore";

// task-04 acceptance criteria (spec v2 §8.1):
// - 全軸満点で 100、全0で 0
// - 既定重みでの代表ケース（期待値を手計算して固定）
// - config の重みを差し替えると結果が変わる（重み外部化の確認）
// - 純粋関数（同入力→同出力・外部 I/O なし）

// 既定重み（§8.10 正本）: spend5 / dissatisfaction4 / pain3 / frequency3 / discoverability3 / substitute2

const maxInputs: InitialInputs = {
  spend: 5,
  dissatisfaction: 5,
  pain: 5,
  frequency: 5,
  discoverability: 5,
  substitute: 5,
};

const zeroInputs: InitialInputs = {
  spend: 0,
  dissatisfaction: 0,
  pain: 0,
  frequency: 0,
  discoverability: 0,
  substitute: 0,
};

describe("computeInitialScore", () => {
  it("returns 100 when every axis is maxed (default weights)", () => {
    // (5*5)+(5*4)+(5*3)+(5*3)+(5*3)+(5*2) = 25+20+15+15+15+10 = 100
    expect(computeInitialScore(maxInputs, scoringConfig)).toBe(100);
  });

  it("returns 0 when every axis is zero", () => {
    expect(computeInitialScore(zeroInputs, scoringConfig)).toBe(0);
  });

  it("computes a representative case with default weights (hand-calculated)", () => {
    const inputs: InitialInputs = {
      spend: 5,
      dissatisfaction: 3,
      pain: 2,
      frequency: 1,
      discoverability: 0,
      substitute: 4,
    };
    // 5*5 + 3*4 + 2*3 + 1*3 + 0*3 + 4*2 = 25+12+6+3+0+8 = 54
    expect(computeInitialScore(inputs, scoringConfig)).toBe(54);
  });

  it("weights Spend highest among the axes (1 point of spend > 1 point of substitute)", () => {
    const onlySpend = computeInitialScore({ ...zeroInputs, spend: 1 }, scoringConfig);
    const onlySubstitute = computeInitialScore({ ...zeroInputs, substitute: 1 }, scoringConfig);
    expect(onlySpend).toBe(5);
    expect(onlySubstitute).toBe(2);
    expect(onlySpend).toBeGreaterThan(onlySubstitute);
  });

  it("changes the result when config weights are swapped (weights are externalized)", () => {
    const inputs: InitialInputs = {
      spend: 5,
      dissatisfaction: 3,
      pain: 2,
      frequency: 1,
      discoverability: 0,
      substitute: 4,
    };
    // 全重み 1 の config を作ると、結果は素点の単純合計になる。
    const unitWeightConfig: ScoringConfig = {
      ...scoringConfig,
      initialWeights: {
        spend: 1,
        dissatisfaction: 1,
        pain: 1,
        frequency: 1,
        discoverability: 1,
        substitute: 1,
      },
    };
    // 5+3+2+1+0+4 = 15（既定重みの 54 とは異なる）
    expect(computeInitialScore(inputs, unitWeightConfig)).toBe(15);
    expect(computeInitialScore(inputs, unitWeightConfig)).not.toBe(
      computeInitialScore(inputs, scoringConfig),
    );
  });

  it("is a pure function (same input → same output, no side effects)", () => {
    const inputs: InitialInputs = {
      spend: 2,
      dissatisfaction: 2,
      pain: 2,
      frequency: 2,
      discoverability: 2,
      substitute: 2,
    };
    const frozenInputs = Object.freeze({ ...inputs });
    const first = computeInitialScore(frozenInputs, scoringConfig);
    const second = computeInitialScore(frozenInputs, scoringConfig);
    expect(first).toBe(second);
    // 入力オブジェクトが変更されていない（副作用なし）
    expect(frozenInputs).toEqual(inputs);
  });
});
