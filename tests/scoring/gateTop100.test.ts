import { describe, expect, it } from "vitest";

import { scoringConfig, type ScoringConfig } from "../../lib/scoring/config";
import {
  evaluateTop100Gate,
  type GateTop100Inputs,
  type StrongSignalType,
} from "../../lib/scoring/gateTop100";

// task-05 acceptance criteria (spec v2 §8.2):
// - 全条件満たす → pass=true, reasons=[]
// - 各条件を1つずつ欠けさせると pass=false かつ該当 reason が入る（境界 58/57, 2/1 含む）
// - config 閾値変更が判定に反映される
// - 純粋関数 / 閾値ハードコードなし
//
// 既定閾値（§8.10 正本 / config.gates.top100）:
//   minScore 58 / minDistinctSources 2 / maxLegalRisk 3 / maxOpsRisk 3

// 全条件を満たす基準ケース（ここから1条件ずつ欠けさせる）。
const passingInputs: GateTop100Inputs = {
  initialScore: 58,
  distinctSourceTypes: 2,
  strongSignalTypes: new Set<StrongSignalType>(["spend"]),
  legalRisk: 3,
  opsRisk: 3,
};

describe("evaluateTop100Gate", () => {
  it("passes with empty reasons when every condition is met", () => {
    const result = evaluateTop100Gate(passingInputs, scoringConfig);
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails when InitialScore is below the threshold (boundary 58/57)", () => {
    // 境界: 58 は合格、57 は不合格
    expect(evaluateTop100Gate({ ...passingInputs, initialScore: 58 }, scoringConfig).pass).toBe(
      true,
    );
    const result = evaluateTop100Gate({ ...passingInputs, initialScore: 57 }, scoringConfig);
    expect(result.pass).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("InitialScore");
  });

  it("fails when distinct source types are below the threshold (boundary 2/1)", () => {
    // 境界: 2 は合格、1 は不合格
    expect(
      evaluateTop100Gate({ ...passingInputs, distinctSourceTypes: 2 }, scoringConfig).pass,
    ).toBe(true);
    const result = evaluateTop100Gate({ ...passingInputs, distinctSourceTypes: 1 }, scoringConfig);
    expect(result.pass).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("独立チャネル数");
  });

  it("fails when no strong signal is present", () => {
    const result = evaluateTop100Gate(
      { ...passingInputs, strongSignalTypes: new Set<StrongSignalType>() },
      scoringConfig,
    );
    expect(result.pass).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("強シグナル");
  });

  it("accepts any one of the strong signal types (dissatisfaction / search)", () => {
    expect(
      evaluateTop100Gate(
        { ...passingInputs, strongSignalTypes: new Set<StrongSignalType>(["dissatisfaction"]) },
        scoringConfig,
      ).pass,
    ).toBe(true);
    expect(
      evaluateTop100Gate(
        { ...passingInputs, strongSignalTypes: new Set<StrongSignalType>(["search"]) },
        scoringConfig,
      ).pass,
    ).toBe(true);
  });

  it("fails when legalRisk exceeds the maximum (boundary 3/4)", () => {
    expect(evaluateTop100Gate({ ...passingInputs, legalRisk: 3 }, scoringConfig).pass).toBe(true);
    const result = evaluateTop100Gate({ ...passingInputs, legalRisk: 4 }, scoringConfig);
    expect(result.pass).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("legalRisk");
  });

  it("fails when opsRisk exceeds the maximum (boundary 3/4)", () => {
    expect(evaluateTop100Gate({ ...passingInputs, opsRisk: 3 }, scoringConfig).pass).toBe(true);
    const result = evaluateTop100Gate({ ...passingInputs, opsRisk: 4 }, scoringConfig);
    expect(result.pass).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("opsRisk");
  });

  it("lists every failing condition at once", () => {
    const result = evaluateTop100Gate(
      {
        initialScore: 10,
        distinctSourceTypes: 0,
        strongSignalTypes: new Set<StrongSignalType>(),
        legalRisk: 5,
        opsRisk: 5,
      },
      scoringConfig,
    );
    expect(result.pass).toBe(false);
    // 5条件すべて不足
    expect(result.reasons).toHaveLength(5);
  });

  it("reflects config threshold changes (thresholds are not hard-coded)", () => {
    // minScore を 90 に引き上げると、既定では合格だった 58 が不合格になる。
    const strictConfig: ScoringConfig = {
      ...scoringConfig,
      gates: {
        ...scoringConfig.gates,
        top100: { ...scoringConfig.gates.top100, minScore: 90 },
      },
    };
    expect(evaluateTop100Gate(passingInputs, scoringConfig).pass).toBe(true);
    const result = evaluateTop100Gate(passingInputs, strictConfig);
    expect(result.pass).toBe(false);
    expect(result.reasons[0]).toContain("InitialScore");
  });

  it("is a pure function (same input → same output, no mutation)", () => {
    const frozenSignals = new Set<StrongSignalType>(["spend"]);
    const inputs: GateTop100Inputs = Object.freeze({
      initialScore: 70,
      distinctSourceTypes: 3,
      strongSignalTypes: frozenSignals,
      legalRisk: 1,
      opsRisk: 1,
    });
    const first = evaluateTop100Gate(inputs, scoringConfig);
    const second = evaluateTop100Gate(inputs, scoringConfig);
    expect(first).toEqual(second);
    // 入力集合が変更されていない（副作用なし）
    expect([...frozenSignals]).toEqual(["spend"]);
  });
});
