import { describe, expect, it } from "vitest";

import {
  DECISION_TYPE_VALUES,
  EVIDENCE_TYPE_VALUES,
  ORIGIN_VALUES,
  REJECTED_REASON_CODE_VALUES,
  SOURCE_TYPE_VALUES,
  SPEND_TYPE_VALUES,
  STAGE_VALUES,
  STATUS_VALUES,
  decisionTypeSchema,
  evidenceTypeSchema,
  originSchema,
  rejectedReasonCodeSchema,
  sourceTypeSchema,
  spendTypeSchema,
  stageSchema,
  statusSchema,
} from "../lib/validation/enums";
import {
  candidateInputSchema,
  confidence01,
  decisionInputSchema,
  evidenceLinkInputSchema,
  parseJsonField,
  rawSignalInputSchema,
  score0to5,
  serializeJsonField,
} from "../lib/validation/schemas";

// task-02 acceptance criteria:
// - every enum exports + rejects invalid values
// - array ⇄ JSON-string helper round-trips
// - 0-5 / 0-1 boundary values (-1, 6, 1.1) are rejected

describe("enums", () => {
  const cases = [
    { name: "sourceType", schema: sourceTypeSchema, values: SOURCE_TYPE_VALUES },
    { name: "status", schema: statusSchema, values: STATUS_VALUES },
    { name: "stage", schema: stageSchema, values: STAGE_VALUES },
    { name: "evidenceType", schema: evidenceTypeSchema, values: EVIDENCE_TYPE_VALUES },
    { name: "decisionType", schema: decisionTypeSchema, values: DECISION_TYPE_VALUES },
    { name: "spendType", schema: spendTypeSchema, values: SPEND_TYPE_VALUES },
    { name: "origin", schema: originSchema, values: ORIGIN_VALUES },
    {
      name: "rejectedReasonCode",
      schema: rejectedReasonCodeSchema,
      values: REJECTED_REASON_CODE_VALUES,
    },
  ] as const;

  for (const { name, schema, values } of cases) {
    it(`${name}: accepts every declared value`, () => {
      for (const value of values) {
        expect(schema.parse(value)).toBe(value);
      }
    });

    it(`${name}: rejects unknown / mis-cased values`, () => {
      expect(schema.safeParse("definitely_not_a_member").success).toBe(false);
      // 表記揺れ（"AppStore" vs "app_store" 等）も弾く
      expect(schema.safeParse(values[0].toUpperCase()).success).toBe(false);
      expect(schema.safeParse("").success).toBe(false);
      expect(schema.safeParse(42).success).toBe(false);
    });
  }

  it("sourceType rejects the canonical typo example 'AppStore'", () => {
    expect(sourceTypeSchema.safeParse("AppStore").success).toBe(false);
    expect(sourceTypeSchema.safeParse("app_store").success).toBe(true);
  });
});

describe("score0to5", () => {
  it("accepts integer boundaries 0..5", () => {
    for (const n of [0, 1, 2, 3, 4, 5]) {
      expect(score0to5.parse(n)).toBe(n);
    }
  });

  it("rejects out-of-range and non-integer values (-1, 6, 1.1)", () => {
    expect(score0to5.safeParse(-1).success).toBe(false);
    expect(score0to5.safeParse(6).success).toBe(false);
    expect(score0to5.safeParse(1.1).success).toBe(false);
  });
});

describe("confidence01", () => {
  it("accepts the continuous range [0, 1]", () => {
    for (const n of [0, 0.5, 1]) {
      expect(confidence01.parse(n)).toBe(n);
    }
  });

  it("rejects out-of-range values (-0.1, 1.1)", () => {
    expect(confidence01.safeParse(-0.1).success).toBe(false);
    expect(confidence01.safeParse(1.1).success).toBe(false);
  });
});

describe("JSON field helpers", () => {
  it("round-trips arrays", () => {
    const tags = ["billing", "ocr", "invoice"];
    expect(parseJsonField(serializeJsonField(tags), [])).toEqual(tags);
  });

  it("round-trips objects", () => {
    const extra = { volume: 1200, difficulty: 0.4, chance: "high" };
    expect(parseJsonField(serializeJsonField(extra), {})).toEqual(extra);
  });

  it("round-trips an empty array (schema default)", () => {
    expect(parseJsonField(serializeJsonField([]), null)).toEqual([]);
  });

  it("returns the fallback for null / undefined / empty string", () => {
    expect(parseJsonField(null, [])).toEqual([]);
    expect(parseJsonField(undefined, [])).toEqual([]);
    expect(parseJsonField("", [])).toEqual([]);
  });

  it("returns the fallback for malformed JSON instead of throwing", () => {
    expect(parseJsonField("{not valid json", [])).toEqual([]);
  });

  it("serializes undefined to a valid JSON null literal", () => {
    expect(serializeJsonField(undefined)).toBe("null");
  });
});

describe("rawSignalInputSchema", () => {
  it("parses a minimal valid input and applies defaults", () => {
    const parsed = rawSignalInputSchema.parse({
      sourceType: "app_store",
      rawText: "Top free finance app, 1.2k reviews complaining about export.",
    });
    expect(parsed.origin).toBe("manual");
    expect(parsed.status).toBe("inbox");
    expect(parsed.signalTags).toEqual([]);
    expect(parsed.extra).toEqual({});
  });

  it("rejects an invalid sourceType", () => {
    const result = rawSignalInputSchema.safeParse({
      sourceType: "AppStore",
      rawText: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty rawText", () => {
    expect(rawSignalInputSchema.safeParse({ sourceType: "app_store", rawText: "" }).success).toBe(
      false,
    );
  });
});

describe("candidateInputSchema", () => {
  it("parses a valid input and defaults stage/origin", () => {
    const parsed = candidateInputSchema.parse({
      title: "請求書OCR自動仕分け",
      spendType: "subscription",
      initialInputs: {
        spend: 4,
        pain: 5,
        frequency: 3,
        discoverability: 2,
        dissatisfaction: 4,
        substitute: 2,
        legalRisk: 1,
        opsRisk: 1,
      },
      confidence: 0.7,
    });
    expect(parsed.stage).toBe("normalized");
    expect(parsed.origin).toBe("manual");
    expect(parsed.productFormFit).toEqual([]);
  });

  it("rejects an out-of-range initialInputs score", () => {
    const result = candidateInputSchema.safeParse({
      title: "x",
      initialInputs: {
        spend: 6,
        pain: 5,
        frequency: 3,
        discoverability: 2,
        dissatisfaction: 4,
        substitute: 2,
        legalRisk: 1,
        opsRisk: 1,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid rejectedReasonCode", () => {
    expect(
      candidateInputSchema.safeParse({ title: "x", rejectedReasonCode: "because_i_said_so" })
        .success,
    ).toBe(false);
  });
});

describe("evidenceLinkInputSchema", () => {
  it("requires rawSignalId (一次ソース必須) and defaults credibility to 3", () => {
    const parsed = evidenceLinkInputSchema.parse({
      candidateId: "cand_1",
      rawSignalId: "rs_1",
      evidenceType: "spend",
      strength: 4,
    });
    expect(parsed.credibility).toBe(3);
  });

  it("rejects a missing rawSignalId", () => {
    const result = evidenceLinkInputSchema.safeParse({
      candidateId: "cand_1",
      evidenceType: "spend",
      strength: 4,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid evidenceType", () => {
    expect(
      evidenceLinkInputSchema.safeParse({
        candidateId: "cand_1",
        rawSignalId: "rs_1",
        evidenceType: "vibes",
        strength: 4,
      }).success,
    ).toBe(false);
  });
});

describe("decisionInputSchema", () => {
  it("parses a valid decision", () => {
    const parsed = decisionInputSchema.parse({
      candidateId: "cand_1",
      decisionType: "promote",
      fromStage: "top100",
      toStage: "top30",
      reason: "3 distinct sources + spend evidence",
    });
    expect(parsed.decisionType).toBe("promote");
  });

  it("rejects a missing reason (reason は必須)", () => {
    expect(
      decisionInputSchema.safeParse({ candidateId: "cand_1", decisionType: "hold" }).success,
    ).toBe(false);
  });

  it("rejects an invalid decisionType", () => {
    expect(
      decisionInputSchema.safeParse({
        candidateId: "cand_1",
        decisionType: "yeet",
        reason: "x",
      }).success,
    ).toBe(false);
  });
});
