// DetailedScore 計算 API（詳細スコアの結線）— task-30, spec v2 §8.4 / §8.5 / §8.6 / §8.7 / §8.9。
//
// POST /api/scoring/detailed/[candidateId] — path の [candidateId] が対象。
// Top100 を通過した候補を Top30 へ絞り込むための詳細スコア（§8.4-8.5）を計算・保存する。
// 「自動計算の境界」はここ（§8.9: 加重和・ボーナス・ペナルティ・confidence・ゲート判定は自動、
// 素点と不確実性レベルは人間）。route は次を結線するだけで、計算式そのものは持たない:
//   1. body の詳細素点12軸（各 0〜5）＋不確実性レベルを Zod 検証
//   2. detailedScore / signalBonus / uncertaintyPenalty（task-26）で各サブスコアを計算
//   3. evidenceRepo.signalStatsByCandidate（task-10）で distinct source / 直接支出 / 最新観測を取得
//   4. computeConfidence（task-06・§8.6）で confidence を算出
//   5. candidateRepo.saveScores（task-09）で保存（task-28 が ScoreSnapshot を自動記録）
//   6. evaluateTop30Gate（task-27・§8.7）の pass/reasons をレスポンスに含める
//
// SignalBonus は signalStats の distinct source 数と直接支出有無から自動で決まる（§8.5）。
// UncertaintyPenalty のレベル（enough / mixed / unconfirmed）だけは人間判断で渡す（§8.5）。
//
// 返却は { data } / { error } 一貫形。成功は 200 で
//   { data: { candidate, detailedScore, signalBonus, uncertaintyPenalty, totalForGate, confidence,
//             gate: { pass, reasons } } }。
//
// エラー → HTTP の翻訳:
// - ZodError（不正素点 / 不正レベル）→ 400（issues 付き）
// - candidate が存在しない            → 404
// - それ以外                          → 500
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { z } from "zod";

import { candidateRepo } from "../../../../../lib/db/candidateRepo";
import { evidenceRepo } from "../../../../../lib/db/evidenceRepo";
import { computeConfidence } from "../../../../../lib/scoring/confidence";
import { scoringConfig } from "../../../../../lib/scoring/config";
import {
  detailedScore as computeDetailedScore,
  signalBonus as computeSignalBonus,
  totalForGate,
  uncertaintyPenalty as computeUncertaintyPenalty,
  type DetailedInputs,
} from "../../../../../lib/scoring/detailedScore";
import { evaluateTop30Gate } from "../../../../../lib/scoring/gateTop30";
import { score0to5 } from "../../../../../lib/validation/schemas";

/** 動的セグメント [candidateId] を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ candidateId: string }> };

/** recencyFactor を [0,1] に正規化する窓（日）。この窓より古い観測は寄与 0（scoring/initial と一致）。 */
const RECENCY_WINDOW_DAYS = 180;
const MS_PER_DAY = 86_400_000;

/**
 * 詳細スコアのリクエスト body。12軸の素点（各 0〜5・§8.4）に、不確実性レベル（§8.5・人間判断）を
 * 添える。レベルはスコアリング内部のカテゴリ（ドメイン enum ではない）なので、detailedScore.ts の
 * UncertaintyLevel と同様にローカルの z.enum で受ける（既定は enough＝ペナルティなし）。
 */
const detailedRequestSchema = z.object({
  spend: score0to5,
  wtp: score0to5,
  acquisition: score0to5,
  pain: score0to5,
  frequency: score0to5,
  retention: score0to5,
  competitorPain: score0to5,
  differentiation: score0to5,
  formFit: score0to5,
  pfFit: score0to5,
  buildEase: score0to5,
  legalSafety: score0to5,
  uncertaintyLevel: z.enum(["enough", "mixed", "unconfirmed"]).default("enough"),
});

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
 * 観測が無ければ 0、RECENCY_WINDOW_DAYS 以内なら線形に 1→0 へ減衰する（scoring/initial と同一）。
 */
function recencyFactor(latestObservedAt: Date | null): number {
  if (latestObservedAt === null) return 0;
  const days = (Date.now() - latestObservedAt.getTime()) / MS_PER_DAY;
  return Math.min(Math.max(1 - days / RECENCY_WINDOW_DAYS, 0), 1);
}

/**
 * POST /api/scoring/detailed/[candidateId] — DetailedScore / SignalBonus / UncertaintyPenalty /
 * confidence を計算・保存し（snapshot 自動記録）、Top30 ゲート判定を返す。
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
    // 詳細素点12軸＋不確実性レベルを検証（範囲外・欠落・不正レベルは 400）。
    const { uncertaintyLevel, ...axes } = detailedRequestSchema.parse(body);
    const inputs: DetailedInputs = axes;

    // 対象 candidate の存在を確認（不在は 404）。
    if ((await candidateRepo.getById(candidateId)) === null) {
      return Response.json(
        { error: { message: "Candidate が見つかりません" } },
        { status: 404 },
      );
    }

    // Evidence 由来の集計（distinct source / 平均 strength / 直接支出 / 最新観測）。
    const stats = await evidenceRepo.signalStatsByCandidate(candidateId);

    // 計算は純粋関数に委譲（重み・ボーナス額は config から・§8.10）。
    const detailedScoreValue = computeDetailedScore(inputs, scoringConfig);
    const signalBonusValue = computeSignalBonus(
      stats.distinctSourceTypes,
      stats.hasDirectSpend,
      scoringConfig,
    );
    const uncertaintyPenaltyValue = computeUncertaintyPenalty(uncertaintyLevel);
    const total = totalForGate(detailedScoreValue, signalBonusValue, uncertaintyPenaltyValue);

    // confidence（§8.6）も signalStats から再計算する（scoring/initial と同一の式）。
    const hasDirectSpendEvidence: 0 | 1 = stats.hasDirectSpend ? 1 : 0;
    const confidence = computeConfidence({
      distinctSourceTypes: stats.distinctSourceTypes,
      avgEvidenceStrength: stats.avgStrength,
      hasDirectSpendEvidence,
      recencyFactor: recencyFactor(stats.latestObservedAt),
    });

    // 詳細素点・派生スコア・configVersion を保存（saveScores が ScoreSnapshot を自動記録・task-28）。
    // detailedInputs は Record<string, number> として保存する（DetailedInputs は全軸 number なので安全）。
    const candidate = await candidateRepo.saveScores(candidateId, {
      detailedInputs: inputs as unknown as Record<string, number>,
      detailedScore: detailedScoreValue,
      signalBonus: signalBonusValue,
      uncertaintyPenalty: uncertaintyPenaltyValue,
      confidence,
      scoreConfigVersion: scoringConfig.version,
    });

    // Top30 ゲート（§8.7）を判定する。testableWithinDays は保存後の candidate を一次ソースにする。
    const gate = evaluateTop30Gate(
      {
        totalForGate: total,
        confidence,
        distinctSourceTypes: stats.distinctSourceTypes,
        testableWithinDays: candidate.testableWithinDays,
      },
      scoringConfig,
    );

    return Response.json(
      {
        data: {
          candidate,
          detailedScore: detailedScoreValue,
          signalBonus: signalBonusValue,
          uncertaintyPenalty: uncertaintyPenaltyValue,
          totalForGate: total,
          confidence,
          gate,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
