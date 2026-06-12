// Candidate 昇格 API — task-30, spec v2 §8.2 / §8.7 / §8.9 / §15.3。
//
// POST /api/candidates/[id]/promote — Candidate の stage を1段昇格する。
// 昇格は「人間が起動し、ゲートは自動判定する」境界に従う（§8.9: stage 進級＝人間、
// ゲート判定＝自動。システムは自動昇格しない）。task-21 の Slice 1 版（normalized→top100
// の単段・履歴記録なし）を、task-30 で多段昇格＋ DecisionLog 記録（§15.3）へ拡張する。
//
// route が結線するもの:
//   1. 対象 Candidate を取得（不在 → 404）
//   2. 現 stage の「次の1段」を昇格パスから決める（終端 stage = 昇格不可 → 409）
//   3. 次段にゲートがあれば自動判定する（未達は昇格不可 → 422＋不足理由）
//        - → top100: Top100 進級ゲート（§8.2・task-05）。未採点（initialScore null）は前提不足
//        - → top30 : Top30 進級ゲート（§8.7・task-27）。未採点（detailedScore null）は前提不足
//        - → hypothesis15 以降: 自動ゲート無し（Top15 以降は人間判断・§8.8）。人間トリガを記録する
//   4. candidateRepo.setStage で1段昇格し、task-29 decisionLogRepo.log で DecisionLog(promote) を残す
//
// ゲート判定式そのものは純粋関数（evaluateTop100Gate / evaluateTop30Gate）に委譲し、route は
// 入力（保存済みスコア＋Evidence 集計）を結線するだけにする。Top30 の TotalForGate は
// 保存済みの detailedScore + signalBonus - uncertaintyPenalty（task-26 の合成式）で再構成する。
//
// reason（§15.3）は body の `reason` を使う。人間操作で省略された場合に DecisionLog の必須 reason
// を満たせなくなるのを避けるため、未指定時は「{from}→{to} へ昇格」の既定理由を補う（昇格イベント
// 自体は decisionType / fromStage / toStage の構造化フィールドで追える）。
//
// エラー → HTTP の翻訳:
// - getById が null            → 404
// - 終端 stage（次段なし）      → 409（昇格対象でない／既に最終段）
// - 未採点・ゲート未通過        → 422（error.reasons に不足条件を載せる）
// - Prisma P2025（対象行なし）  → 404
// - それ以外                    → 500
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { Prisma } from "@prisma/client";

import { candidateRepo, type SettableStage } from "../../../../../lib/db/candidateRepo";
import { decisionLogRepo } from "../../../../../lib/db/decisionLogRepo";
import { STRONG_SIGNAL_TYPES, evidenceRepo } from "../../../../../lib/db/evidenceRepo";
import { totalForGate } from "../../../../../lib/scoring/detailedScore";
import { scoringConfig } from "../../../../../lib/scoring/config";
import { evaluateTop100Gate, type StrongSignalType } from "../../../../../lib/scoring/gateTop100";
import { evaluateTop30Gate } from "../../../../../lib/scoring/gateTop30";
import {
  decisionTypeSchema,
  stageSchema,
  type EvidenceType,
  type Stage,
} from "../../../../../lib/validation/enums";

/** 動的セグメント [id]（= candidateId）を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ id: string }> };

/**
 * 各 stage の「次の1段」。昇格は1段ずつ進む（§8.9）。終端（rejected / archived / focus）は
 * 次段を持たない＝昇格不可（409）。enum 値は task-02 の Zod スキーマ経由で参照し直書きを避ける。
 * 値は SettableStage（rejected を含まない）に収まる（rejected への遷移は reject 経由のみ・§15.1）。
 */
const NEXT_STAGE: Partial<Record<Stage, SettableStage>> = {
  [stageSchema.enum.normalized]: stageSchema.enum.top100,
  [stageSchema.enum.top100]: stageSchema.enum.top30,
  [stageSchema.enum.top30]: stageSchema.enum.hypothesis15,
  [stageSchema.enum.hypothesis15]: stageSchema.enum.smoke_test,
  [stageSchema.enum.smoke_test]: stageSchema.enum.mvp,
  [stageSchema.enum.mvp]: stageSchema.enum.focus,
};

/**
 * signalStats の強シグナル集合（Set<EvidenceType>）を Top100 ゲートが要求する
 * Set<StrongSignalType> へ絞り込む。enum 文字列は直書きせず STRONG_SIGNAL_TYPES を経由。
 */
function toStrongSignalSet(types: ReadonlySet<EvidenceType>): Set<StrongSignalType> {
  const strong = new Set<StrongSignalType>();
  for (const type of STRONG_SIGNAL_TYPES) {
    if (types.has(type)) strong.add(type);
  }
  return strong;
}

/** 昇格できない（前提不足・ゲート未通過）ときの 422 応答。不足理由を reasons に載せる。 */
function blockedResponse(message: string, reasons: string[]): Response {
  return Response.json({ error: { message, reasons } }, { status: 422 });
}

/**
 * POST /api/candidates/[id]/promote — stage を1段昇格（人間操作・§8.9）し、DecisionLog を残す。
 * body は任意で `{ reason?: string }`。次段にゲートがあれば自動判定し、通過時のみ昇格する。
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { id } = await ctx.params;

    // body の reason は任意（空・未指定・不正 JSON は既定理由で補う）。
    let reason: string | undefined;
    try {
      const body = (await request.json()) as { reason?: unknown };
      if (typeof body?.reason === "string" && body.reason.trim() !== "") {
        reason = body.reason;
      }
    } catch {
      // body 無し / 不正 JSON は許容（reason は既定理由で補う）。
    }

    const candidate = await candidateRepo.getById(id);
    if (candidate === null) {
      return Response.json({ error: { message: "Candidate が見つかりません" } }, { status: 404 });
    }

    const fromStage = candidate.stage as Stage;
    const toStage = NEXT_STAGE[fromStage];
    if (toStage === undefined) {
      // 終端 stage（focus / rejected / archived）からは昇格できない。
      return Response.json(
        {
          error: {
            message: `この stage（${fromStage}）からは昇格できません（昇格対象の次段がありません）`,
          },
        },
        { status: 409 },
      );
    }

    // 次段にゲートがあれば自動判定する（→top100: §8.2 / →top30: §8.7）。
    if (toStage === stageSchema.enum.top100) {
      if (candidate.initialScore === null) {
        return blockedResponse(
          "未採点のため昇格できません。先に Scoring を保存してゲートを満たしてください",
          ["InitialScore が未計算（Scoring 未保存）"],
        );
      }
      const stats = await evidenceRepo.signalStatsByCandidate(id);
      // legalRisk/opsRisk は採点時の素点（initialInputs）を一次ソースにする（top100 route と一致）。
      const legalRisk = candidate.initialInputs?.legalRisk ?? candidate.legalRisk ?? 0;
      const opsRisk = candidate.initialInputs?.opsRisk ?? candidate.opsRisk ?? 0;
      const gate = evaluateTop100Gate(
        {
          initialScore: candidate.initialScore,
          distinctSourceTypes: stats.distinctSourceTypes,
          strongSignalTypes: toStrongSignalSet(stats.strongSignalTypes),
          legalRisk,
          opsRisk,
        },
        scoringConfig,
      );
      if (!gate.pass) {
        return blockedResponse("Top100 進級ゲート未通過のため昇格できません", gate.reasons);
      }
    } else if (toStage === stageSchema.enum.top30) {
      if (candidate.detailedScore === null) {
        return blockedResponse(
          "詳細スコア未計算のため昇格できません。先に詳細スコアを保存してゲートを満たしてください",
          ["DetailedScore が未計算（詳細採点 未保存）"],
        );
      }
      const stats = await evidenceRepo.signalStatsByCandidate(id);
      // TotalForGate を保存済みスコアから再構成する（§8.4: DetailedScore + SignalBonus - UncertaintyPenalty）。
      const total = totalForGate(
        candidate.detailedScore,
        candidate.signalBonus ?? 0,
        candidate.uncertaintyPenalty ?? 0,
      );
      const gate = evaluateTop30Gate(
        {
          totalForGate: total,
          confidence: candidate.confidence ?? 0,
          distinctSourceTypes: stats.distinctSourceTypes,
          testableWithinDays: candidate.testableWithinDays,
        },
        scoringConfig,
      );
      if (!gate.pass) {
        return blockedResponse("Top30 進級ゲート未通過のため昇格できません", gate.reasons);
      }
    }
    // hypothesis15 以降は自動ゲート無し（Top15 以降は人間判断・§8.8）。人間トリガの記録のみ行う。

    // ゲート通過 → 1段昇格。stage 永続化に続けて DecisionLog(promote) を刻む（§15.3）。
    // 昇格イベントは decisionType/fromStage/toStage の構造化フィールドで追えるため、
    // reason 未指定時は遷移を説明する既定理由を補う（DecisionLog の必須 reason を満たす）。
    const data = await candidateRepo.setStage(id, toStage);
    await decisionLogRepo.log({
      candidateId: id,
      decisionType: decisionTypeSchema.enum.promote,
      fromStage,
      toStage,
      reason: reason ?? `${fromStage}→${toStage} へ昇格`,
    });
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return Response.json({ error: { message: "Candidate が見つかりません" } }, { status: 404 });
    }
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
