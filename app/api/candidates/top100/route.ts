// Top100 一覧 API（ゲート通過候補）— task-13, spec v2 §8.2 / §13 Slice 1。
//
// GET /api/candidates/top100 — 全 Candidate に Top100 進級ゲート（§8.2）を動的に判定し、
// pass のものだけを返す。stage 昇格（人間操作・task-21）とは独立で、ここは「ゲート通過を
// 動的表示」する Slice 1 版。判定式そのものは純粋関数 evaluateTop100Gate に委譲し、route は
// 入力（保存済み initialScore＋Evidence 集計＋legalRisk/opsRisk）を結線するだけ。
//
// gate の legalRisk/opsRisk は scoring/initial が保存した initialInputs を一次ソースとし、
// 無ければ candidate のリスク列、最後に 0 へフォールバックする（未採点候補は initialScore が
// null のため、そもそもゲート対象外＝除外する）。
//
// 返却は { data } / { error } 一貫形。成功は 200 で { data: CandidateListItem[] }（pass のみ）。

import {
  candidateRepo,
  type CandidateListItem,
} from "../../../../lib/db/candidateRepo";
import { STRONG_SIGNAL_TYPES, evidenceRepo } from "../../../../lib/db/evidenceRepo";
import { scoringConfig } from "../../../../lib/scoring/config";
import { evaluateTop100Gate, type StrongSignalType } from "../../../../lib/scoring/gateTop100";
import type { EvidenceType } from "../../../../lib/validation/enums";

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
 * GET /api/candidates/top100 — Top100 ゲートを通過する候補のみを返す。
 * 未採点（initialScore が null）の候補はゲート対象外として除外する。
 */
export async function GET(): Promise<Response> {
  try {
    const candidates = await candidateRepo.list();
    const passing: CandidateListItem[] = [];

    for (const candidate of candidates) {
      // 未採点候補はゲート判定の前提（InitialScore）を欠くため除外する。
      if (candidate.initialScore === null) continue;

      const stats = await evidenceRepo.signalStatsByCandidate(candidate.id);
      // legalRisk/opsRisk は採点時の素点（initialInputs）を一次ソースにする（scoring/initial と一致）。
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
      if (gate.pass) passing.push(candidate);
    }

    return Response.json({ data: passing }, { status: 200 });
  } catch {
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
