// Weekly Report API — task-38, spec v2 §9.9。
//
// GET /api/reports/weekly?since=YYYY-MM-DD —
//   指定期間（since 〜 now）の週次レポート Markdown を text/markdown で返す。
// 生成本体は純粋関数（lib/report/weekly.ts）に委譲し、ここはデータ収集（repository 経由）と
// HTTP 翻訳だけを行う薄い route（既存 export route と同じ流儀）。Prisma は直接触らない。
//
// データ源（§9.9）:
// - スコア上昇/低下 … snapshotRepo.weekDelta（task-28・候補ごとの期間差分）
// - Top100 入り / 棄却 … decisionLogRepo（task-29・期間内の toStage / reject 判断）
// - 棄却理由コード分布 … Candidate.rejectedReasonCode（§15.1）
// - 来週見る市場 … watchlistRepo の deltaFlag（task-36）
// - 今週追加 Raw Signal … rawSignalRepo（addedAt が期間内）
// - Top30 / 次に深掘り(hypothesis15) / Smoke Test 候補 … Candidate.stage
//
// 集計は候補ごとに weekDelta / decisionLog を引く（N+1）が、単一ローカルユーザー前提で件数が
// 小さいことを利用する（candidateRepo.list の minEvidence と同じ割り切り）。
//
// エラー → HTTP の翻訳:
// - since が日付として不正 → 400
// - それ以外               → 500
// 成功は 200・text/markdown（charset=utf-8）＋ Content-Disposition（DL 用 filename）。

import { z } from "zod";

import { candidateRepo } from "../../../../lib/db/candidateRepo";
import { decisionLogRepo } from "../../../../lib/db/decisionLogRepo";
import { rawSignalRepo } from "../../../../lib/db/rawSignalRepo";
import { snapshotRepo } from "../../../../lib/db/snapshotRepo";
import { watchlistRepo } from "../../../../lib/db/watchlistRepo";
import { stageSchema } from "../../../../lib/validation/enums";
import {
  buildWeeklyReport,
  weeklyReportRange,
  type ScoreMovement,
  type WatchlistChange,
  type WeeklyReportData,
} from "../../../../lib/report/weekly";

/** ?since= の検証。ISO 文字列 / YYYY-MM-DD を Date に coerce する。 */
const sinceSchema = z.coerce.date();

/** weekDelta の差分から代表スコア（detailedScore 優先・無ければ initialScore）を取り出す。 */
function pickScore(
  wd: Awaited<ReturnType<typeof snapshotRepo.weekDelta>>,
): { before: number; after: number; delta: number } | null {
  if (wd.first === null || wd.last === null) return null;
  if (wd.delta.detailedScore !== null) {
    return {
      before: wd.first.detailedScore!,
      after: wd.last.detailedScore!,
      delta: wd.delta.detailedScore,
    };
  }
  if (wd.delta.initialScore !== null) {
    return {
      before: wd.first.initialScore!,
      after: wd.last.initialScore!,
      delta: wd.delta.initialScore,
    };
  }
  return null;
}

/**
 * GET /api/reports/weekly — 指定期間の週報 Markdown を返す。
 * since 省略時は now から 7 日前を既定とする。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const until = new Date();
    const rawSince = new URL(request.url).searchParams.get("since");
    let since: Date;
    if (rawSince) {
      const parsed = sinceSchema.safeParse(rawSince);
      if (!parsed.success) {
        return Response.json(
          { error: { message: "since は日付（YYYY-MM-DD など）で指定してください" } },
          { status: 400 },
        );
      }
      since = parsed.data;
    } else {
      since = weeklyReportRange(until).since;
    }

    const inPeriod = (at: Date): boolean => at >= since && at <= until;

    // 候補一覧（stage / rejectedReasonCode / evidenceCount を含む）。
    const candidates = await candidateRepo.list();

    const scoreMovements: ScoreMovement[] = [];
    const enteredTop100: WeeklyReportData["enteredTop100"] = [];

    for (const c of candidates) {
      const ref = { displayId: c.displayId, title: c.title };

      // スコア上昇/低下（snapshot 差分）。
      const wd = await snapshotRepo.weekDelta(c.id, since);
      const picked = pickScore(wd);
      if (picked) scoreMovements.push({ ...ref, ...picked });

      // Top100 入りは promote 判断（DecisionLog に残る・task-29）から拾う。期間は decidedAt で絞る。
      const logs = await decisionLogRepo.listByCandidate(c.id);
      if (logs.some((l) => inPeriod(l.decidedAt) && l.toStage === stageSchema.enum.top100)) {
        enteredTop100.push(ref);
      }
    }

    // 棄却（理由コード分布・§15.1）。phase2 指摘①: 通常の棄却は DecisionLog に残らない
    // （candidateRepo.reject は Candidate を更新するだけ）ため、判断ログからは拾えない。
    // stage==='rejected' かつ rejectedReasonCode を持つ候補を集計対象とし、期間絞りは weekly.ts 側で
    // 専用フィールド rejectedAt に対して厳密に行う（改善①: 旧来の updatedAt 近似を廃止。棄却後に
    // 当該候補を編集して updatedAt が動いても期間判定がズレない）。
    // 旧データ（移行前に棄却済み＝rejectedAt が null）は期間外として除外する（selectRejected の
    // null=期間外 セマンティクス）。正確な棄却時刻が無い旧棄却を「最近の棄却」に誤計上しない
    // ＝ updatedAt フォールバックは行わない（それは是正したい近似バグの再導入になるため）。
    const rejected: WeeklyReportData["rejected"] = candidates
      .filter((c) => c.stage === stageSchema.enum.rejected && c.rejectedReasonCode !== null)
      .map((c) => ({
        displayId: c.displayId,
        title: c.title,
        reasonCode: c.rejectedReasonCode,
        rejectedAt: c.rejectedAt,
      }));

    // stage ベースのセクション。
    const activeStages = new Set<string>([stageSchema.enum.rejected, stageSchema.enum.archived]);
    const needsInvestigation = candidates
      .filter((c) => !activeStages.has(c.stage) && c.evidenceCount === 0)
      .map((c) => ({ displayId: c.displayId, title: c.title }));
    const top30 = candidates
      .filter((c) => c.stage === stageSchema.enum.top30)
      .map((c) => ({ displayId: c.displayId, title: c.title }));
    const digDeeper = candidates
      .filter((c) => c.stage === stageSchema.enum.hypothesis15)
      .map((c) => ({ displayId: c.displayId, title: c.title }));
    const smokeTestCandidates = candidates
      .filter((c) => c.stage === stageSchema.enum.smoke_test)
      .map((c) => ({ displayId: c.displayId, title: c.title }));

    // 今週追加した Raw Signal。
    const rawSignals = await rawSignalRepo.list();
    const newRawSignals = rawSignals
      .filter((r) => inPeriod(r.addedAt))
      .map((r) => ({
        displayId: r.displayId,
        sourceType: r.sourceType,
        observedEntity: r.observedEntity,
        summary: r.rawText,
      }));

    // 来週見る市場（Watchlist の差分）。deltaFlag up/down かつ期間内に記録されたものへの絞り込みは
    // weekly.ts の selectWatchlistChanges が担う（phase2 指摘②: 古い up/down の毎週再掲を防ぐ）。
    // ここは lastCheckedAt を含む全件を渡す。
    const watchlist = await watchlistRepo.list();
    const watchlistChanges: WatchlistChange[] = watchlist.map((w) => ({
      entityType: w.entityType,
      entityName: w.entityName,
      metricName: w.metricName,
      lastValue: w.lastValue,
      currentValue: w.currentValue,
      deltaFlag: w.deltaFlag,
      lastCheckedAt: w.lastCheckedAt,
    }));

    const markdown = buildWeeklyReport({
      since,
      until,
      newRawSignals,
      enteredTop100,
      scoreMovements,
      needsInvestigation,
      rejected,
      top30,
      digDeeper,
      smokeTestCandidates,
      watchlistChanges,
    });

    const filename = `weekly-report-${until.toISOString().slice(0, 10)}.md`;
    return new Response(markdown, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch {
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
