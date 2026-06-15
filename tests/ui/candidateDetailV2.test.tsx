import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DETAILED_AXES,
  DETAILED_INPUT_KEYS,
  DetailedScorePanel,
  DetailedScoreResultView,
  buildDetailedInputs,
  buildTop30Advice,
  detailedEndpoint,
  submitDetailedScore,
  type DetailedScoringResult,
} from "../../components/candidate/DetailedScorePanel";
import {
  ScoreHistoryView,
  fetchSnapshots,
  formatSnapshotAt,
  snapshotsEndpoint,
  type ScoreSnapshotRow,
} from "../../components/candidate/ScoreHistory";
import {
  DecisionLogListView,
  decisionLogsEndpoint,
  decisionTypeLabel,
  decisionTypeTone,
  fetchDecisionLogs,
  formatDecidedAt,
  formatStageTransition,
  type DecisionLogRow,
} from "../../components/candidate/DecisionLogList";
import {
  ScoreConfidenceMatrix,
  candidateToPoint,
  confidenceToRow,
  fetchCandidatePoint,
  plotPoint,
  scoreToColumn,
  type MatrixPoint,
} from "../../components/candidate/ScoreConfidenceMatrix";
import {
  canSubmitMerge,
  canSubmitSplit,
  mergeEndpoint,
  parseIdList,
  splitEndpoint,
  submitMerge,
  submitSplit,
} from "../../components/candidate/MergeSplitDialog";

// task-31 Candidate 詳細 v2（spec v2 §8.4-8.7 / §9.4 / §9.5 / §15.2-15.3）。
// テスト基盤に DOM/インタラクション依存は足さない方針のため、ロジック（入力組立・送信・アドバイス
// 導出・取得・配置計算）は純関数（fetcher DI）として駆動し、表示は react-dom/server の静的描画で
// 確認する。テストの import は相対パス（@/ エイリアスは vitest 非対応）。

/** 最後に呼ばれた url / init を記録する擬似 fetch。data を返す。 */
function makeFakeApi(data: unknown, ok = true, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      json: async () => data,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

// ---------------------------------------------------------------------------
// DetailedScorePanel: 詳細素点の組立・送信・Top30 進級アドバイス
// ---------------------------------------------------------------------------

describe("DetailedScorePanel: 詳細素点の組立", () => {
  it("12軸＋不確実性レベルを欠けなく埋める（未入力は 0）", () => {
    expect(DETAILED_AXES).toHaveLength(12);
    expect(DETAILED_INPUT_KEYS).toHaveLength(12);
    const inputs = buildDetailedInputs({ spend: 5 }, "enough");
    for (const key of DETAILED_INPUT_KEYS) {
      expect(key in inputs).toBe(true);
    }
    expect(inputs.spend).toBe(5);
    expect(inputs.wtp).toBe(0);
    expect(inputs.uncertaintyLevel).toBe("enough");
  });

  it("素点は 0〜5 の整数へクランプ/丸めする", () => {
    const inputs = buildDetailedInputs({ spend: 9, pain: -2, frequency: 3.4 }, "mixed");
    expect(inputs.spend).toBe(5);
    expect(inputs.pain).toBe(0);
    expect(inputs.frequency).toBe(3);
    expect(inputs.uncertaintyLevel).toBe("mixed");
  });
});

describe("DetailedScorePanel: Top30 進級アドバイス（reasons → 手当て）", () => {
  it("通過時は blockers も nextSteps も空", () => {
    const advice = buildTop30Advice({ pass: true, reasons: [] });
    expect(advice.pass).toBe(true);
    expect(advice.blockers).toEqual([]);
    expect(advice.nextSteps).toEqual([]);
  });

  it("不足理由を blockers に並べ、種別ごとに nextSteps へ翻訳する", () => {
    const advice = buildTop30Advice({
      pass: false,
      reasons: ["独立チャネル数が不足（1 < 必要 2）", "確信度が不足"],
    });
    expect(advice.pass).toBe(false);
    expect(advice.blockers).toHaveLength(2);
    expect(advice.nextSteps.some((s) => s.includes("独立チャネル"))).toBe(true);
    expect(advice.nextSteps.some((s) => s.includes("確信度"))).toBe(true);
  });
});

describe("DetailedScorePanel: 送信（fetcher DI）", () => {
  const okData = {
    data: {
      candidate: { id: "c1" },
      detailedScore: 70,
      signalBonus: 5,
      uncertaintyPenalty: 0,
      totalForGate: 75,
      confidence: 0.7,
      gate: { pass: true, reasons: [] },
    },
  };

  it("scoring/detailed の endpoint へ 12素点＋レベルを POST し、結果を返す", async () => {
    const { calls, fetcher } = makeFakeApi(okData);
    const result = await submitDetailedScore("c1", { spend: 5 }, "enough", fetcher);
    expect(calls[0].url).toBe(detailedEndpoint("c1"));
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body.uncertaintyLevel).toBe("enough");
    for (const key of DETAILED_INPUT_KEYS) {
      expect(key in body).toBe(true);
    }
    expect(result.totalForGate).toBe(75);
    expect(result.gate.pass).toBe(true);
  });

  it("!ok なら例外を投げる", async () => {
    const { fetcher } = makeFakeApi({}, false, 500);
    await expect(submitDetailedScore("c1", {}, "enough", fetcher)).rejects.toThrow();
  });
});

describe("DetailedScoreResultView: 結果と Top30 可否の描画", () => {
  it("通過時はゲート通過と promote 案内を出す", () => {
    const result: DetailedScoringResult = {
      detailedScore: 70,
      signalBonus: 5,
      uncertaintyPenalty: 0,
      totalForGate: 75,
      confidence: 0.7,
      gate: { pass: true, reasons: [] },
    };
    const html = renderToStaticMarkup(<DetailedScoreResultView result={result} />);
    expect(html).toContain("DetailedScore");
    expect(html).toContain("TotalForGate");
    expect(html).toContain("通過");
    expect(html).toContain("promote");
  });

  it("未通過時は不足条件と次手当てを出す", () => {
    const result: DetailedScoringResult = {
      detailedScore: 30,
      signalBonus: 0,
      uncertaintyPenalty: 10,
      totalForGate: 20,
      confidence: 0.2,
      gate: { pass: false, reasons: ["独立チャネル数が不足（1 < 必要 2）"] },
    };
    const html = renderToStaticMarkup(<DetailedScoreResultView result={result} />);
    expect(html).toContain("未通過");
    expect(html).toContain("不足している条件");
    expect(html).toContain("独立チャネル");
  });
});

describe("DetailedScorePanel: 描画スモーク", () => {
  it("12軸・レベル選択・保存/promote ボタンを描画する", () => {
    const html = renderToStaticMarkup(<DetailedScorePanel candidateId="c1" />);
    expect(html).toContain("詳細12軸");
    expect(html).toContain("Spend");
    expect(html).toContain("LegalSafety");
    expect(html).toContain("不確実性レベル");
    expect(html).toContain("保存して計算");
    expect(html).toContain("promote");
  });
});

// ---------------------------------------------------------------------------
// ScoreHistory: 取得・整形・描画
// ---------------------------------------------------------------------------

describe("ScoreHistory: 取得と整形", () => {
  it("snapshots を取得して data を返す（0 件は空配列）", async () => {
    const rows: ScoreSnapshotRow[] = [
      {
        id: "s1",
        snapshotAt: "2026-02-01T03:04:05.000Z",
        initialScore: 80,
        detailedScore: 70,
        signalBonus: 5,
        uncertaintyPenalty: 0,
        confidence: 0.7,
        configVersion: "v1",
        reason: "saveScores",
      },
    ];
    const ok = makeFakeApi({ data: rows });
    expect(await fetchSnapshots("c1", ok.fetcher)).toHaveLength(1);
    expect(ok.calls[0].url).toBe(snapshotsEndpoint("c1"));

    const empty = makeFakeApi({ data: [] });
    expect(await fetchSnapshots("c1", empty.fetcher)).toEqual([]);
  });

  it("取得が !ok なら throw する", async () => {
    const { fetcher } = makeFakeApi({}, false, 404);
    await expect(fetchSnapshots("c1", fetcher)).rejects.toThrow();
  });

  it("snapshotAt は YYYY-MM-DD HH:mm（UTC・locale 非依存）に整形する", () => {
    expect(formatSnapshotAt("2026-02-01T03:04:05.000Z")).toBe("2026-02-01 03:04");
    expect(formatSnapshotAt("not-a-date")).toBe("not-a-date");
  });
});

describe("ScoreHistoryView: 描画", () => {
  it("件数と行（スコア・確信度）を描画する", () => {
    const rows: ScoreSnapshotRow[] = [
      {
        id: "s1",
        snapshotAt: "2026-02-01T03:04:05.000Z",
        initialScore: 82,
        detailedScore: 70,
        signalBonus: 5,
        uncertaintyPenalty: 0,
        confidence: 0.7,
        configVersion: "v1",
        reason: "saveScores",
      },
    ];
    const html = renderToStaticMarkup(<ScoreHistoryView snapshots={rows} />);
    expect(html).toContain("スコア履歴（1）");
    expect(html).toContain("2026-02-01 03:04");
    expect(html).toContain("82.0");
    expect(html).toContain("0.70");
  });

  it("0 件は空表示", () => {
    const html = renderToStaticMarkup(<ScoreHistoryView snapshots={[]} />);
    expect(html).toContain("スコア履歴（0）");
    expect(html).toContain("スコア履歴はありません");
  });
});

// ---------------------------------------------------------------------------
// DecisionLogList: 取得・整形・描画
// ---------------------------------------------------------------------------

describe("DecisionLogList: 取得と整形", () => {
  it("判断ログを取得して data を返す（0 件は空配列）", async () => {
    const rows: DecisionLogRow[] = [
      {
        id: "d1",
        decisionType: "promote",
        fromStage: "normalized",
        toStage: "top100",
        relatedCandidateId: null,
        reason: "昇格",
        decidedAt: "2026-02-01T03:04:05.000Z",
      },
    ];
    const ok = makeFakeApi({ data: rows });
    expect(await fetchDecisionLogs("c1", ok.fetcher)).toHaveLength(1);
    expect(ok.calls[0].url).toBe(decisionLogsEndpoint("c1"));

    const empty = makeFakeApi({ data: [] });
    expect(await fetchDecisionLogs("c1", empty.fetcher)).toEqual([]);
  });

  it("decisionType を日本語ラベルと色へ写す（未知値はそのまま/neutral）", () => {
    expect(decisionTypeLabel("promote")).toBe("昇格");
    expect(decisionTypeLabel("merge")).toBe("統合");
    expect(decisionTypeLabel("unknown")).toBe("unknown");
    expect(decisionTypeTone("reject")).toBe("danger");
    expect(decisionTypeTone("unknown")).toBe("neutral");
  });

  it("stage 遷移は from → to へ整形する（片側のみにも耐える）", () => {
    expect(formatStageTransition("normalized", "top100")).toBe("normalized → top100");
    expect(formatStageTransition(null, "top100")).toBe("→ top100");
    expect(formatStageTransition(null, null)).toBe("");
  });

  it("decidedAt は YYYY-MM-DD HH:mm に整形する", () => {
    expect(formatDecidedAt("2026-02-01T03:04:05.000Z")).toBe("2026-02-01 03:04");
  });
});

describe("DecisionLogListView: 描画", () => {
  it("件数・種別ラベル・遷移・理由を描画する", () => {
    const rows: DecisionLogRow[] = [
      {
        id: "d1",
        decisionType: "merge",
        fromStage: null,
        toStage: null,
        relatedCandidateId: "c2",
        reason: "重複のため統合",
        decidedAt: "2026-02-01T03:04:05.000Z",
      },
    ];
    const html = renderToStaticMarkup(<DecisionLogListView logs={rows} />);
    expect(html).toContain("判断ログ（1）");
    expect(html).toContain("統合");
    expect(html).toContain("重複のため統合");
    expect(html).toContain("c2");
  });

  it("0 件は空表示", () => {
    const html = renderToStaticMarkup(<DecisionLogListView logs={[]} />);
    expect(html).toContain("判断ログ（0）");
    expect(html).toContain("判断ログはありません");
  });
});

// ---------------------------------------------------------------------------
// ScoreConfidenceMatrix: 配置計算・写像・描画
// ---------------------------------------------------------------------------

describe("ScoreConfidenceMatrix: 配置計算", () => {
  it("score(0〜100) を列へ写す（低=左・高=右・クランプ）", () => {
    expect(scoreToColumn(0, 5)).toBe(0);
    expect(scoreToColumn(100, 5)).toBe(4);
    expect(scoreToColumn(50, 5)).toBe(2);
    expect(scoreToColumn(-10, 5)).toBe(0);
    expect(scoreToColumn(200, 5)).toBe(4);
  });

  it("confidence(0〜1) を行へ写す（高=上段 row0・低=下段）", () => {
    expect(confidenceToRow(1, 5)).toBe(0);
    expect(confidenceToRow(0, 5)).toBe(4);
    expect(confidenceToRow(0.5, 5)).toBe(2);
  });

  it("plotPoint は未採点（score/confidence が null）なら null を返す", () => {
    const plotted: MatrixPoint = { id: "p1", label: "P1", score: 80, confidence: 0.9 };
    expect(plotPoint(plotted)).not.toBeNull();
    const unscored: MatrixPoint = { id: "p2", label: "P2", score: null, confidence: 0.5 };
    expect(plotPoint(unscored)).toBeNull();
    const unconfident: MatrixPoint = { id: "p3", label: "P3", score: 50, confidence: null };
    expect(plotPoint(unconfident)).toBeNull();
  });

  it("candidateToPoint は detailedScore を優先し、無ければ initialScore を使う", () => {
    expect(
      candidateToPoint({
        id: "c1",
        displayId: "CND-1",
        stage: "top30",
        initialScore: 60,
        detailedScore: 72,
        confidence: 0.8,
      }).score,
    ).toBe(72);
    expect(
      candidateToPoint({
        id: "c2",
        displayId: "CND-2",
        stage: "top100",
        initialScore: 60,
        detailedScore: null,
        confidence: 0.5,
      }).score,
    ).toBe(60);
  });
});

describe("ScoreConfidenceMatrix: 取得と描画", () => {
  it("候補を取得して MatrixPoint へ写す", async () => {
    const { calls, fetcher } = makeFakeApi({
      data: {
        id: "c1",
        displayId: "CND-1",
        stage: "top30",
        initialScore: 60,
        detailedScore: 72,
        confidence: 0.8,
      },
    });
    const point = await fetchCandidatePoint("c1", fetcher);
    expect(calls[0].url).toBe("/api/candidates/c1");
    expect(point.label).toBe("CND-1");
    expect(point.score).toBe(72);
  });

  it("プロット済みの点はラベルを、未採点の点は未配置案内を描画する", () => {
    const points: MatrixPoint[] = [
      { id: "p1", label: "CND-1", score: 90, confidence: 0.9 },
      { id: "p2", label: "CND-2", score: null, confidence: null },
    ];
    const html = renderToStaticMarkup(<ScoreConfidenceMatrix points={points} />);
    expect(html).toContain("score × confidence");
    expect(html).toContain("CND-1");
    expect(html).toContain("未配置");
    expect(html).toContain("CND-2");
  });
});

// ---------------------------------------------------------------------------
// MergeSplitDialog: 確定可否・ID 解析・送信
// ---------------------------------------------------------------------------

describe("MergeSplitDialog: 確定可否と ID 解析", () => {
  it("merge は吸収側 ID と理由がともに必須", () => {
    expect(canSubmitMerge("", "理由")).toBe(false);
    expect(canSubmitMerge("c2", "  ")).toBe(false);
    expect(canSubmitMerge("c2", "重複のため")).toBe(true);
  });

  it("split は理由が必須（Evidence 0 件でも可）", () => {
    expect(canSubmitSplit("  ")).toBe(false);
    expect(canSubmitSplit("混在のため分割")).toBe(true);
  });

  it("parseIdList は改行/カンマ/空白区切りを正規化し空要素を捨てる", () => {
    expect(parseIdList("a, b\n c  d")).toEqual(["a", "b", "c", "d"]);
    expect(parseIdList("  ")).toEqual([]);
  });
});

describe("MergeSplitDialog: 送信（fetcher DI）", () => {
  it("merge は /merge へ absorbedId+reason を POST する", async () => {
    const { calls, fetcher } = makeFakeApi({ data: { absorbedId: "c2" } });
    await submitMerge("c1", { absorbedId: " c2 ", reason: " 重複 " }, fetcher);
    expect(calls[0].url).toBe(mergeEndpoint("c1"));
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body.absorbedId).toBe("c2");
    expect(body.reason).toBe("重複");
  });

  it("merge は未充足なら API を呼ばず throw する", async () => {
    const { calls, fetcher } = makeFakeApi({ data: {} });
    await expect(submitMerge("c1", { absorbedId: "", reason: "x" }, fetcher)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("split は /split へ POST し、title は非空のときだけ含める", async () => {
    const withTitle = makeFakeApi({ data: { newCandidateId: "c3" } });
    await submitSplit(
      "c1",
      { evidenceIds: ["e1", "e2"], reason: "分割", title: " 新候補 " },
      withTitle.fetcher,
    );
    expect(withTitle.calls[0].url).toBe(splitEndpoint("c1"));
    const body1 = JSON.parse(String(withTitle.calls[0].init?.body)) as Record<string, unknown>;
    expect(body1.evidenceIds).toEqual(["e1", "e2"]);
    expect(body1.reason).toBe("分割");
    expect(body1.title).toBe("新候補");

    const noTitle = makeFakeApi({ data: {} });
    await submitSplit("c1", { evidenceIds: [], reason: "分割", title: "  " }, noTitle.fetcher);
    const body2 = JSON.parse(String(noTitle.calls[0].init?.body)) as Record<string, unknown>;
    expect("title" in body2).toBe(false);
  });

  it("split は理由が空なら API を呼ばず throw する", async () => {
    const { calls, fetcher } = makeFakeApi({ data: {} });
    await expect(submitSplit("c1", { evidenceIds: [], reason: "  " }, fetcher)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("!ok（422 等）は error.message を畳んで throw する", async () => {
    const { fetcher } = makeFakeApi(
      { error: { message: "吸収側は既に archived です" } },
      false,
      409,
    );
    await expect(
      submitMerge("c1", { absorbedId: "c2", reason: "重複" }, fetcher),
    ).rejects.toThrow("archived");
  });
});
