// Candidate 昇格 API — task-21, spec v2 §8.2 / §8.9 / §9.5。
//
// POST /api/candidates/[id]/promote — Candidate の stage を1段昇格する。
// 昇格は「人間が起動し、ゲートは自動判定する」境界に従う（§8.9: stage 進級＝人間、
// ゲート判定＝自動。システムは自動昇格しない）。UI（task-21 CandidateDetail）の
// promote ボタンから起動され、route は次を結線する:
//   1. 対象 Candidate を取得（不在 → 404）
//   2. 現 stage が normalized 以外なら 409（Slice 1 は normalized→top100 の1段のみ）
//   3. Top100 進級ゲート（§8.2）を自動判定（未採点 or 未通過 → 422＋不足理由）
//   4. candidateRepo.setStage(id, "top100") で昇格して返す
//
// ゲート判定式そのものは純粋関数 evaluateTop100Gate（task-05）に委譲し、route は入力
// （保存済み initialScore＋Evidence 集計＋legalRisk/opsRisk）を結線するだけ。入力の
// 組み立ては GET /api/candidates/top100（task-13）と同一にし、表示ゲートと昇格ゲートの
// 判定を一致させる（ScoringPanel が見せた pass と昇格可否がずれないようにする）。
//
// エラー → HTTP の翻訳:
// - getById が null            → 404
// - stage が normalized 以外     → 409（昇格対象でない／既に昇格済み等）
// - Top100 ゲート未通過          → 422（error.reasons に不足条件を載せる）
// - Prisma P2025（対象行なし）  → 404
// - それ以外                    → 500
//
// TODO(task-30): 昇格時の DecisionLog 記録（§15.3）と Top30 以降の多段ゲート（§8.7）、
//   merge/split を追加する。本 route は Slice 1 の単段（normalized→top100）・履歴記録なしの
//   最小版にとどめる。
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { Prisma } from "@prisma/client";

import { candidateRepo } from "../../../../../lib/db/candidateRepo";
import { STRONG_SIGNAL_TYPES, evidenceRepo } from "../../../../../lib/db/evidenceRepo";
import { scoringConfig } from "../../../../../lib/scoring/config";
import { evaluateTop100Gate, type StrongSignalType } from "../../../../../lib/scoring/gateTop100";
import type { EvidenceType } from "../../../../../lib/validation/enums";

/** 動的セグメント [id]（= candidateId）を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ id: string }> };

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

/**
 * POST /api/candidates/[id]/promote — normalized → top100 の1段昇格（人間操作・§8.9）。
 * Top100 ゲート（§8.2）を自動判定し、通過時のみ setStage で昇格する。
 */
export async function POST(_request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { id } = await ctx.params;

    const candidate = await candidateRepo.getById(id);
    if (candidate === null) {
      return Response.json({ error: { message: "Candidate が見つかりません" } }, { status: 404 });
    }

    // Slice 1 は normalized→top100 の1段昇格のみ。それ以外の stage からの昇格要求は拒否する
    // （多段昇格・降格は task-30。既に top100 以上、rejected / archived も対象外）。
    // 「任意の stage を直接セットして進級ゲートを迂回する」ことを構造的に防ぐ（§8.9 自動昇格しない）。
    if (candidate.stage !== "normalized") {
      return Response.json(
        {
          error: {
            message: `この stage（${candidate.stage}）からは昇格できません。Slice 1 は normalized→top100 の昇格のみ対応します`,
          },
        },
        { status: 409 },
      );
    }

    // Top100 ゲート（§8.2）を自動判定する。未採点（initialScore null）は判定の前提
    // （InitialScore）を欠くため昇格不可（先に Scoring を保存させる）。
    if (candidate.initialScore === null) {
      return Response.json(
        {
          error: {
            message: "未採点のため昇格できません。先に Scoring を保存してゲートを満たしてください",
            reasons: ["InitialScore が未計算（Scoring 未保存）"],
          },
        },
        { status: 422 },
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
      return Response.json(
        {
          error: { message: "Top100 進級ゲート未通過のため昇格できません", reasons: gate.reasons },
        },
        { status: 422 },
      );
    }

    // ゲート通過 → 昇格。stage 永続化のみ（DecisionLog 記録は task-30）。
    const data = await candidateRepo.setStage(id, "top100");
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return Response.json({ error: { message: "Candidate が見つかりません" } }, { status: 404 });
    }
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
