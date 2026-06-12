// Top30 一覧 API（ゲート通過候補）— task-30, spec v2 §8.7 / §13 Slice 2。
//
// GET /api/candidates/top30 — 全 Candidate に Top30 進級ゲート（§8.7）を動的に判定し、pass の
// ものだけを返す。stage 昇格（人間操作・promote API）とは独立で、ここは「ゲート通過を動的表示」
// する版（top100 route と同じ流儀）。判定式そのものは純粋関数 evaluateTop30Gate に委譲し、route は
// 入力（保存済み detailedScore / signalBonus / uncertaintyPenalty / confidence ＋ Evidence 集計 ＋
// testableWithinDays）を結線するだけ。
//
// TotalForGate は保存済みスコアから再構成する（§8.4: DetailedScore + SignalBonus -
// UncertaintyPenalty）。未採点（detailedScore が null）の候補は前提（DetailedScore）を欠くため
// 除外する（promote API の Top30 判定と一致させ、表示と昇格可否がずれないようにする）。
//
// 返却は { data } / { error } 一貫形。成功は 200 で { data: CandidateListItem[] }（pass のみ）。

import { candidateRepo, type CandidateListItem } from "../../../../lib/db/candidateRepo";
import { evidenceRepo } from "../../../../lib/db/evidenceRepo";
import { totalForGate } from "../../../../lib/scoring/detailedScore";
import { scoringConfig } from "../../../../lib/scoring/config";
import { evaluateTop30Gate } from "../../../../lib/scoring/gateTop30";

/**
 * GET /api/candidates/top30 — Top30 ゲートを通過する候補のみを返す。
 * 未採点（detailedScore が null）の候補はゲート判定の前提を欠くため除外する。
 */
export async function GET(): Promise<Response> {
  try {
    const candidates = await candidateRepo.list();
    const passing: CandidateListItem[] = [];

    for (const candidate of candidates) {
      // 詳細未採点はゲート判定の前提（DetailedScore）を欠くため除外する。
      if (candidate.detailedScore === null) continue;

      const stats = await evidenceRepo.signalStatsByCandidate(candidate.id);
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
      if (gate.pass) passing.push(candidate);
    }

    return Response.json({ data: passing }, { status: 200 });
  } catch {
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
