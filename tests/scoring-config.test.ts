import { describe, expect, it } from "vitest";

import {
  getConfigVersion,
  loadScoringConfig,
  scoringConfig,
  scoringConfigSchema,
} from "../lib/scoring/config";

// task-03 acceptance criteria (spec v2 §8.10):
// - loadScoringConfig() が同梱 JSON を読み Zod 検証を通す
// - 不正 config（重み欠落・型違い）で throw する
// - getConfigVersion() が version 文字列を返す

// §8.10 の正本そのまま（テスト用の参照コピー）
const validConfig = {
  version: "2026.06-v1",
  initialWeights: {
    spend: 5,
    dissatisfaction: 4,
    pain: 3,
    frequency: 3,
    discoverability: 3,
    substitute: 2,
  },
  detailedWeights: {
    spend: 15,
    wtp: 10,
    acquisition: 10,
    pain: 10,
    frequency: 8,
    retention: 8,
    competitorPain: 8,
    differentiation: 8,
    formFit: 7,
    pfFit: 6,
    buildEase: 5,
    legalSafety: 5,
  },
  signalBonus: { "2": 5, "3": 10, "4plusWithSpend": 15 },
  gates: {
    top100: { minScore: 58, minDistinctSources: 2, maxLegalRisk: 3, maxOpsRisk: 3 },
    top30: { minTotal: 68, minConfidence: 0.7, minDistinctSources: 3, maxTestDays: 7 },
  },
} as const;

// 指定キーを除いた浅いコピーを返す（必須キー欠落を作るため）。
function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...obj };
  delete clone[key];
  return clone;
}

describe("loadScoringConfig", () => {
  it("reads the bundled config and passes Zod validation", () => {
    const config = loadScoringConfig();
    expect(config.version).toBe("2026.06-v1");
    expect(config.initialWeights.spend).toBe(5);
    expect(config.detailedWeights.spend).toBe(15);
    expect(config.signalBonus["4plusWithSpend"]).toBe(15);
    expect(config.gates.top100.minScore).toBe(58);
    expect(config.gates.top30.minConfidence).toBe(0.7);
  });

  it("accepts an explicit valid config object", () => {
    expect(() => loadScoringConfig(validConfig)).not.toThrow();
    expect(loadScoringConfig(validConfig)).toEqual(validConfig);
  });

  it("exposes the same validated object via the module-level export", () => {
    expect(scoringConfig).toEqual(validConfig);
  });

  it("throws when a weight is missing", () => {
    const broken = { ...validConfig, initialWeights: omit(validConfig.initialWeights, "spend") };
    expect(() => loadScoringConfig(broken)).toThrow();
  });

  it("throws when a weight has the wrong type", () => {
    const broken = {
      ...validConfig,
      detailedWeights: { ...validConfig.detailedWeights, spend: "15" },
    };
    expect(() => loadScoringConfig(broken)).toThrow();
  });

  it("throws when a gate field is missing", () => {
    const broken = {
      ...validConfig,
      gates: { ...validConfig.gates, top100: omit(validConfig.gates.top100, "minScore") },
    };
    expect(() => loadScoringConfig(broken)).toThrow();
  });

  it("throws when version is missing", () => {
    expect(() => loadScoringConfig(omit(validConfig, "version"))).toThrow();
  });

  it("rejects unknown top-level keys (strict)", () => {
    const broken = { ...validConfig, surprise: true };
    expect(() => loadScoringConfig(broken)).toThrow();
  });

  it("rejects a confidence gate outside [0, 1]", () => {
    const broken = {
      ...validConfig,
      gates: {
        ...validConfig.gates,
        top30: { ...validConfig.gates.top30, minConfidence: 1.5 },
      },
    };
    expect(() => loadScoringConfig(broken)).toThrow();
  });
});

describe("getConfigVersion", () => {
  it("returns the version string", () => {
    const version = getConfigVersion();
    expect(typeof version).toBe("string");
    expect(version).toBe("2026.06-v1");
  });
});

describe("scoringConfigSchema", () => {
  it("is exported for downstream reuse (task-04/05/06/13)", () => {
    expect(scoringConfigSchema.safeParse(validConfig).success).toBe(true);
  });
});
