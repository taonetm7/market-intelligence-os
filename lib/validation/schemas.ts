import { z } from "zod";

import {
  decisionTypeSchema,
  deltaFlagSchema,
  evidenceTypeSchema,
  originSchema,
  rejectedReasonCodeSchema,
  spendTypeSchema,
  stageSchema,
  statusSchema,
  sourceTypeSchema,
  watchlistEntityTypeSchema,
} from "./enums";

// Entity input schemas (task-02).
// These validate user/AI input *before* it reaches the repository layer.
// Out of scope: import-only schemas (task-14) and DB persistence shapes.
// Spec ref: market_intelligence_os_web_app_spec_v2.md §7.2-7.6, §8.9.

// ---------------------------------------------------------------------------
// Reusable primitives
// ---------------------------------------------------------------------------

// 0〜5 の素点（spend / pain / strength / credibility など）(§8.1, §7.4)
export const score0to5 = z.number().int().min(0).max(5);

// confidence は 0〜1（§8.6 の式で算出される連続値）(§7.3)
export const confidence01 = z.number().min(0).max(1);

// ---------------------------------------------------------------------------
// 配列/オブジェクト ⇄ JSON 文字列ヘルパ
// SQLite に配列型が無いため、`*Json` カラムには JSON 文字列を格納する。
// ---------------------------------------------------------------------------

/**
 * 値を JSON 文字列へ直列化する（DB 書き込み用）。
 * `undefined` は `null` として直列化し、常に有効な JSON を返す。
 */
export function serializeJsonField(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * JSON 文字列を復元する（DB 読み出し用）。
 * `null` / `undefined` / 空文字 / 不正 JSON のときは `fallback` を返す。
 */
export function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === "") {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// RawSignalInput (§7.2)
// ---------------------------------------------------------------------------

export const rawSignalInputSchema = z.object({
  sourceType: sourceTypeSchema,
  sourceName: z.string().optional(),
  sourceUrl: z.string().optional(),
  country: z.string().optional(),
  language: z.string().optional(),
  rawText: z.string().min(1),
  observedEntity: z.string().optional(),
  observedPrice: z.string().optional(),
  observedRank: z.string().optional(),
  observedRating: z.number().optional(),
  observedReviews: z.number().int().min(0).optional(),
  observedUpdate: z.coerce.date().optional(),
  // 配列/オブジェクトのドメイン値。永続化時に serializeJsonField で *Json 化する。
  signalTags: z.array(z.string()).default([]),
  extra: z.record(z.string(), z.unknown()).default({}),
  note: z.string().optional(),
  origin: originSchema.default("manual"),
  status: statusSchema.default("inbox"),
});
export type RawSignalInput = z.infer<typeof rawSignalInputSchema>;

// ---------------------------------------------------------------------------
// CandidateInput (§7.3)
// ---------------------------------------------------------------------------

// InitialScore の素点（§7.3 / §8.1）。各 0〜5。
export const initialInputsSchema = z.object({
  spend: score0to5,
  pain: score0to5,
  frequency: score0to5,
  discoverability: score0to5,
  dissatisfaction: score0to5,
  substitute: score0to5,
  legalRisk: score0to5,
  opsRisk: score0to5,
});
export type InitialInputs = z.infer<typeof initialInputsSchema>;

export const candidateInputSchema = z.object({
  problemFamily: z.string().optional(),
  title: z.string().min(1),
  targetUser: z.string().optional(),
  contextTrigger: z.string().optional(),
  painStatement: z.string().optional(),
  currentSubstitute: z.string().optional(),
  spendType: spendTypeSchema.optional(),
  monetizationGuess: z.string().optional(),
  // productFormFit / detailedInputs は永続化時に *Json 化する。
  productFormFit: z.array(z.string()).default([]),
  initialInputs: initialInputsSchema.optional(),
  detailedInputs: z.record(z.string(), score0to5).optional(),
  founderFit: score0to5.optional(),
  buildEase: score0to5.optional(),
  legalRisk: score0to5.optional(),
  opsRisk: score0to5.optional(),
  confidence: confidence01.optional(),
  stage: stageSchema.default("normalized"),
  testableWithinDays: z.number().int().min(0).optional(),
  testMethod: z.string().optional(),
  nextAction: z.string().optional(),
  rejectedReason: z.string().optional(),
  rejectedReasonCode: rejectedReasonCodeSchema.optional(),
  origin: originSchema.default("manual"),
});
export type CandidateInput = z.infer<typeof candidateInputSchema>;

// ---------------------------------------------------------------------------
// EvidenceLinkInput (§7.4)
// Evidence は Candidate × RawSignal の純粋な join。一次ソース(rawSignalId)必須。
// ---------------------------------------------------------------------------

export const evidenceLinkInputSchema = z.object({
  candidateId: z.string().min(1),
  rawSignalId: z.string().min(1),
  evidenceType: evidenceTypeSchema,
  strength: score0to5,
  credibility: score0to5.default(3),
  note: z.string().optional(),
});
export type EvidenceLinkInput = z.infer<typeof evidenceLinkInputSchema>;

// ---------------------------------------------------------------------------
// DecisionInput (§7.6, §15.3)
// ---------------------------------------------------------------------------

export const decisionInputSchema = z.object({
  candidateId: z.string().min(1),
  decisionType: decisionTypeSchema,
  fromStage: stageSchema.optional(),
  toStage: stageSchema.optional(),
  relatedCandidateId: z.string().optional(),
  reason: z.string().min(1),
});
export type DecisionInput = z.infer<typeof decisionInputSchema>;

// ---------------------------------------------------------------------------
// WatchlistInput (§9.8 / フィールドは §7.7)
// 定点観測対象の前回値・今回値・差分。v1 は手動入力（自動取得は §18.3 で out of scope）。
// lastValue / currentValue は単位や表記が様々（"1位" / "¥500" / "3.5"）なので String で持ち、
// 差分方向（deltaFlag）は repository の updateValue が数値比較で算出する。
// ---------------------------------------------------------------------------

export const watchlistInputSchema = z.object({
  entityType: watchlistEntityTypeSchema,
  entityName: z.string().min(1),
  locale: z.string().optional(),
  metricName: z.string().optional(),
  lastValue: z.string().optional(),
  currentValue: z.string().optional(),
  deltaFlag: deltaFlagSchema.default("unknown"),
  lastCheckedAt: z.coerce.date().optional(),
  linkedCandidateId: z.string().optional(),
  note: z.string().optional(),
});
export type WatchlistInput = z.infer<typeof watchlistInputSchema>;
