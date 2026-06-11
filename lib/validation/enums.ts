import { z } from "zod";

// Centralized enum definitions (task-02).
// SQLite has no native enum type, so every "enum" column on the Prisma models
// is a plain String validated here at the application layer with Zod.
// Spec ref: market_intelligence_os_web_app_spec_v2.md §7.2-7.6, §15.1.
//
// Each enum exposes:
// - a frozen value tuple (`*_VALUES`) for iteration / UI option lists,
// - a Zod schema (`*Schema`) for validation,
// - an inferred TypeScript union type.

// RawSignal.sourceType — 一次観測のソース種別 (§7.2)
export const SOURCE_TYPE_VALUES = [
  "app_store",
  "google_play",
  "aso",
  "seo",
  "review",
  "sns",
  "community",
  "outsource",
  "job",
  "regulation",
  "founder",
] as const;
export const sourceTypeSchema = z.enum(SOURCE_TYPE_VALUES);
export type SourceType = z.infer<typeof sourceTypeSchema>;

// RawSignal.status — "linked" は持たない（Evidence 有無で派生判定）(§7.2, §7.7)
export const STATUS_VALUES = ["inbox", "ignored", "archived"] as const;
export const statusSchema = z.enum(STATUS_VALUES);
export type Status = z.infer<typeof statusSchema>;

// Candidate.stage — 正規化からフォーカスまでの進級ステージ (§7.3)
export const STAGE_VALUES = [
  "normalized",
  "top100",
  "top30",
  "hypothesis15",
  "smoke_test",
  "mvp",
  "focus",
  "rejected",
  "archived",
] as const;
export const stageSchema = z.enum(STAGE_VALUES);
export type Stage = z.infer<typeof stageSchema>;

// Evidence.evidenceType — 証拠の種別 (§7.4)
export const EVIDENCE_TYPE_VALUES = [
  "spend",
  "dissatisfaction",
  "search",
  "community",
  "outsourcing",
  "job",
  "regulation",
  "founder",
] as const;
export const evidenceTypeSchema = z.enum(EVIDENCE_TYPE_VALUES);
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;

// DecisionLog.decisionType — 判断の種別 (§7.6, §15.3)
export const DECISION_TYPE_VALUES = [
  "promote",
  "demote",
  "reject",
  "merge",
  "split",
  "hold",
] as const;
export const decisionTypeSchema = z.enum(DECISION_TYPE_VALUES);
export type DecisionType = z.infer<typeof decisionTypeSchema>;

// Candidate.spendType — 既存の支出形態 (§7.3)
export const SPEND_TYPE_VALUES = [
  "subscription",
  "outsourcing",
  "template",
  "course",
  "labor",
  "none",
  "unknown",
] as const;
export const spendTypeSchema = z.enum(SPEND_TYPE_VALUES);
export type SpendType = z.infer<typeof spendTypeSchema>;

// origin — 来歴・監査（RawSignal / Candidate 共通）(§7.2, §7.3, §8.9)
export const ORIGIN_VALUES = ["manual", "import", "ai"] as const;
export const originSchema = z.enum(ORIGIN_VALUES);
export type Origin = z.infer<typeof originSchema>;

// Candidate.rejectedReasonCode — 棄却理由コード（傾向分析用）(§15.1)
export const REJECTED_REASON_CODE_VALUES = [
  "no_purchaser",
  "free_only",
  "legal_risk",
  "too_competitive",
  "weak_mobile_need",
  "high_ai_cost",
  "untestable",
  "low_pain",
  "no_form_fit",
] as const;
export const rejectedReasonCodeSchema = z.enum(REJECTED_REASON_CODE_VALUES);
export type RejectedReasonCode = z.infer<typeof rejectedReasonCodeSchema>;
