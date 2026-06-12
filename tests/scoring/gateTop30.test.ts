import { describe, expect, it } from "vitest";

import { scoringConfig, type ScoringConfig } from "../../lib/scoring/config";
import {
  evaluateTop30Gate,
  type GateTop30Inputs,
} from "../../lib/scoring/gateTop30";

// task-27 acceptance criteria (spec v2 §8.7):
// - 全条件満たすと pass=true
// - 各条件欠落で pass=false ＋該当 reason（境界 68/67・0.7/0.69・3/2・7/8）
// - testableWithinDays=null が不合格になる
// - config 閾値変更が反映される（外部化）
// - 純粋関数

// 既定 config.gates.top30（§8.7 正本）:
//   minTotal 68 / minConfidence 0.7 / minDistinctSources 3 / maxTestDays 7

// 全条件を満たす基準入力（個別条件を1つずつ崩して pass=false を確認する土台）。
const passingInputs: GateTop30Inputs = {
  totalForGate: 68,
  confidence: 0.7,
  distinctSourceTypes: 3,
  testableWithinDays: 7,
};

describe("evaluateTop30Gate", () => {
  it("passes when every condition is met (boundary values inclusive)", () => {
    const result = evaluateTop30Gate(passingInputs, scoringConfig);
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("passes comfortably above every threshold", () => {
    const result = evaluateTop30Gate(
      { totalForGate: 90, confidence: 0.95, distinctSourceTypes: 5, testableWithinDays: 1 },
      scoringConfig,
    );
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  describe("totalForGate boundary (>= minTotal 68)", () => {
    it("passes at exactly 68", () => {
      expect(evaluateTop30Gate({ ...passingInputs, totalForGate: 68 }, scoringConfig).pass).toBe(
        true,
      );
    });

    it("fails at 67 with a TotalForGate reason", () => {
      const result = evaluateTop30Gate({ ...passingInputs, totalForGate: 67 }, scoringConfig);
      expect(result.pass).toBe(false);
      expect(result.reasons).toEqual([
        expect.stringContaining("TotalForGate"),
      ]);
    });
  });

  describe("confidence boundary (>= minConfidence 0.7)", () => {
    it("passes at exactly 0.7", () => {
      expect(evaluateTop30Gate({ ...passingInputs, confidence: 0.7 }, scoringConfig).pass).toBe(
        true,
      );
    });

    it("fails at 0.69 with a confidence reason", () => {
      const result = evaluateTop30Gate({ ...passingInputs, confidence: 0.69 }, scoringConfig);
      expect(result.pass).toBe(false);
      expect(result.reasons).toEqual([expect.stringContaining("confidence")]);
    });
  });

  describe("distinctSourceTypes boundary (>= minDistinctSources 3)", () => {
    it("passes at exactly 3", () => {
      expect(
        evaluateTop30Gate({ ...passingInputs, distinctSourceTypes: 3 }, scoringConfig).pass,
      ).toBe(true);
    });

    it("fails at 2 with an independent-channel reason", () => {
      const result = evaluateTop30Gate({ ...passingInputs, distinctSourceTypes: 2 }, scoringConfig);
      expect(result.pass).toBe(false);
      expect(result.reasons).toEqual([expect.stringContaining("独立チャネル数")]);
    });
  });

  describe("testableWithinDays boundary (<= maxTestDays 7)", () => {
    it("passes at exactly 7", () => {
      expect(
        evaluateTop30Gate({ ...passingInputs, testableWithinDays: 7 }, scoringConfig).pass,
      ).toBe(true);
    });

    it("fails at 8 with a test-days reason", () => {
      const result = evaluateTop30Gate({ ...passingInputs, testableWithinDays: 8 }, scoringConfig);
      expect(result.pass).toBe(false);
      expect(result.reasons).toEqual([expect.stringContaining("検証までの日数")]);
    });
  });

  describe("testableWithinDays = null (検証手段未定義)", () => {
    it("fails even when every other condition is met", () => {
      const result = evaluateTop30Gate(
        { ...passingInputs, testableWithinDays: null },
        scoringConfig,
      );
      expect(result.pass).toBe(false);
      expect(result.reasons).toEqual([expect.stringContaining("検証手段が未定義")]);
    });

    it("does not emit the maxTestDays comparison reason for null", () => {
      const result = evaluateTop30Gate(
        { ...passingInputs, testableWithinDays: null },
        scoringConfig,
      );
      expect(result.reasons.some((r) => r.includes("検証までの日数"))).toBe(false);
    });
  });

  it("lists every failing condition when all are violated", () => {
    const result = evaluateTop30Gate(
      { totalForGate: 0, confidence: 0, distinctSourceTypes: 0, testableWithinDays: null },
      scoringConfig,
    );
    expect(result.pass).toBe(false);
    expect(result.reasons).toHaveLength(4);
    expect(result.reasons.some((r) => r.includes("TotalForGate"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("confidence"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("独立チャネル数"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("検証手段が未定義"))).toBe(true);
  });

  it("reflects config threshold changes (thresholds are externalized)", () => {
    // minTotal を 90 に引き上げると、既定では通っていた 68 が不合格になる。
    const stricter: ScoringConfig = {
      ...scoringConfig,
      gates: {
        ...scoringConfig.gates,
        top30: { ...scoringConfig.gates.top30, minTotal: 90 },
      },
    };
    expect(evaluateTop30Gate(passingInputs, scoringConfig).pass).toBe(true);
    const result = evaluateTop30Gate(passingInputs, stricter);
    expect(result.pass).toBe(false);
    expect(result.reasons).toEqual([expect.stringContaining("90")]);
  });

  it("relaxing config thresholds lets a previously failing candidate pass", () => {
    // maxTestDays を 30 に緩めると、既定で落ちる testableWithinDays=8 が通る。
    const relaxed: ScoringConfig = {
      ...scoringConfig,
      gates: {
        ...scoringConfig.gates,
        top30: { ...scoringConfig.gates.top30, maxTestDays: 30 },
      },
    };
    const slow = { ...passingInputs, testableWithinDays: 8 };
    expect(evaluateTop30Gate(slow, scoringConfig).pass).toBe(false);
    expect(evaluateTop30Gate(slow, relaxed).pass).toBe(true);
  });

  it("is a pure function (same input → same output, no input mutation)", () => {
    const frozen = Object.freeze({ ...passingInputs });
    const first = evaluateTop30Gate(frozen, scoringConfig);
    const second = evaluateTop30Gate(frozen, scoringConfig);
    expect(first).toEqual(second);
    expect(frozen).toEqual(passingInputs);
  });
});
