// InitialScore 計算 API（スコア計算の結線）— task-13, spec v2 §8.1 / §8.2 / §8.6 / §8.9。
//
// POST /api/scoring/initial/[candidateId] — path の [id] = candidateId。
// 「自動計算の境界」はここ（§8.9: 重み付き合計・ゲート判定・集計は自動、素点は人間）。
// route handler は次を結線するだけで、計算式そのものは持たない（純粋関数に委譲）:
//   1. body の素点（initialInputsSchema）を Zod 検証（task-02）
//   2. evidenceRepo.signalStatsByCandidate で distinct/strength/直接支出/最新観測を取得（task-10）
//   3. computeInitialScore（task-04）・computeConfidence（task-06）で計算
//   4. candidateRepo.saveScores で保存（scoreConfigVersion 付き・task-09）
//   5. evaluateTop100Gate（task-05）の pass/reasons をレスポンスに含める
//
// エラー → HTTP の翻訳:
// - ZodError（不正素点）        → 400（issues 付き）
// - candidate が存在しない      → 404
// - それ以外                    → 500
//
// 返却は { data } / { error } 一貫形。成功は 200 で
//   { data: { candidate, initialScore, confidence, gate: { pass, reasons } } }。
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { z } from "zod";

import { candidateRepo } from "../../../../../lib/db/candidateRepo";
import { STRONG_SIGNAL_TYPES, evidenceRepo } from "../../../../../lib/db/evidenceRepo";
import { computeConfidence } from "../../../../../lib/scoring/confidence";
import { scoringConfig } from "../../../../../lib/scoring/config";
import { evaluateTop100Gate, type StrongSignalType } from "../../../../../lib/scoring/gateTop100";
import { computeInitialScore } from "../../../../../lib/scoring/initialScore";
import type { EvidenceType } from "../../../../../lib/validation/enums";
import { initialInputsSchema } from "../../../../../lib/validation/schemas";

/** 動的セグメント [candidateId] を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ candidateId: string }> };

/** recencyFactor を [0,1] に正規化する窓（日）。この窓より古い観測は寄与 0。 */
const RECENCY_WINDOW_DAYS = 180;
const MS_PER_DAY = 86_400_000;

/** ZodError → 400、それ以外 → 500 に翻訳する共通応答。 */
function errorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: { message: "入力が不正です", issues: error.issues } },
      { status: 400 },
    );
  }
  return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
}

/**
 * 最新観測時刻から recencyFactor（0〜1）を導出する（§8.6: 直近観測ほど高い）。
 * 観測が無ければ 0、RECENCY_WINDOW_DAYS 以内なら線形に 1→0 へ減衰する。
 * confidence.ts は recency の正規化を呼び出し側の責務としているため、ここで吸収する。
 */
function recencyFactor(latestObservedAt: Date | null): number {
  if (latestObservedAt === null) return 0;
  const days = (Date.now() - latestObservedAt.getTime()) / MS_PER_DAY;
  return Math.min(Math.max(1 - days / RECENCY_WINDOW_DAYS, 0), 1);
}

/**
 * signalStats の強シグナル集合（Set<EvidenceType>）を、Top100 ゲートが要求する
 * Set<StrongSignalType>（spend / dissatisfaction / search）へ絞り込む。
 * enum 文字列は直書きせず evidenceRepo の STRONG_SIGNAL_TYPES を経由する。
 */
function toStrongSignalSet(types: ReadonlySet<EvidenceType>): Set<StrongSignalType> {
  const strong = new Set<StrongSignalType>();
  for (const type of STRONG_SIGNAL_TYPES) {
    if (types.has(type)) strong.add(type);
  }
  return strong;
}

/**
 * POST /api/scoring/initial/[candidateId] — InitialScore / confidence を計算・保存し、
 * Top100 ゲート判定を返す。body は initialInputsSchema の素点（各 0〜5・legalRisk/opsRisk 含む）。
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { candidateId } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { message: "リクエストボディの JSON が不正です" } },
      { status: 400 },
    );
  }
  try {
    // 素点を検証（範囲外・欠落は 400）。
    const inputs = initialInputsSchema.parse(body);

    // 対象 candidate の存在を確認（不在は 404）。
    if ((await candidateRepo.getById(candidateId)) === null) {
      return Response.json(
        { error: { message: "Candidate が見つかりません" } },
        { status: 404 },
      );
    }

    // Evidence 由来の集計（distinct source / 平均 strength / 直接支出 / 最新観測 / 強シグナル）。
    const stats = await evidenceRepo.signalStatsByCandidate(candidateId);

    // 計算は純粋関数に委譲（重みは config から・§8.10）。
    const initialScore = computeInitialScore(inputs, scoringConfig);
    const hasDirectSpendEvidence: 0 | 1 = stats.hasDirectSpend ? 1 : 0;
    const confidence = computeConfidence({
      distinctSourceTypes: stats.distinctSourceTypes,
      avgEvidenceStrength: stats.avgStrength,
      hasDirectSpendEvidence,
      recencyFactor: recencyFactor(stats.latestObservedAt),
    });
    const gate = evaluateTop100Gate(
      {
        initialScore,
        distinctSourceTypes: stats.distinctSourceTypes,
        strongSignalTypes: toStrongSignalSet(stats.strongSignalTypes),
        legalRisk: inputs.legalRisk,
        opsRisk: inputs.opsRisk,
      },
      scoringConfig,
    );

    // 素点・派生スコア・configVersion を保存（§7.3 再計算/監査のため素点も残す）。
    const candidate = await candidateRepo.saveScores(candidateId, {
      initialInputs: inputs,
      initialScore,
      confidence,
      scoreConfigVersion: scoringConfig.version,
    });

    return Response.json(
      { data: { candidate, initialScore, confidence, gate } },
      { status: 200 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
