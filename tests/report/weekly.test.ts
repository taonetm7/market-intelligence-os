import { describe, expect, it } from "vitest";

import {
  buildWeeklyReport,
  rejectedDistribution,
  selectRejected,
  selectWatchlistChanges,
  splitMovements,
  weeklyReportRange,
  type RejectedEntry,
  type ScoreMovement,
  type WatchlistChange,
  type WeeklyReportData,
} from "../../lib/report/weekly";

// 期間の代表時刻。emptyData の since(06-11)〜until(06-18) の内/外で使う。
const IN_PERIOD = new Date("2026-06-15T00:00:00.000Z");
const BEFORE_PERIOD = new Date("2026-06-01T00:00:00.000Z");

// task-38 — Weekly Report 生成（純粋関数）の単体テスト（spec v2 §9.9）。
// I/O を持たない buildWeeklyReport / 補助関数を直接駆動し、各セクションの生成を検証する。
// import は相対パス（@/ エイリアスは vitest 非対応）。

/** 全セクション空の最小データ（since/until のみ指定）。 */
function emptyData(overrides: Partial<WeeklyReportData> = {}): WeeklyReportData {
  return {
    since: new Date("2026-06-11T00:00:00.000Z"),
    until: new Date("2026-06-18T00:00:00.000Z"),
    newRawSignals: [],
    enteredTop100: [],
    scoreMovements: [],
    needsInvestigation: [],
    rejected: [],
    top30: [],
    digDeeper: [],
    smokeTestCandidates: [],
    watchlistChanges: [],
    ...overrides,
  };
}

describe("weeklyReportRange", () => {
  it("until を基準に since = until - 7 日 を返す", () => {
    const until = new Date("2026-06-18T09:00:00.000Z");
    const { since } = weeklyReportRange(until);
    expect(since.toISOString()).toBe("2026-06-11T09:00:00.000Z");
  });
});

describe("splitMovements", () => {
  const movements: ScoreMovement[] = [
    { displayId: "CND-1", title: "上昇", before: 3, after: 4, delta: 1 },
    { displayId: "CND-2", title: "低下", before: 4, after: 2, delta: -2 },
    { displayId: "CND-3", title: "据置", before: 3, after: 3, delta: 0 },
    { displayId: "CND-4", title: "大上昇", before: 1, after: 4, delta: 3 },
  ];

  it("delta>0 を上昇・delta<0 を低下に振り分け、delta===0 は除外する", () => {
    const { up, down } = splitMovements(movements);
    expect(up.map((m) => m.displayId)).toEqual(["CND-4", "CND-1"]); // delta 降順
    expect(down.map((m) => m.displayId)).toEqual(["CND-2"]); // delta 昇順（最も下げた順）
  });
});

/** RejectedEntry を簡潔に作るヘルパ（rejectedAt 既定は期間内）。 */
function rej(
  displayId: string,
  reasonCode: string | null,
  rejectedAt: Date = IN_PERIOD,
): RejectedEntry {
  return { displayId, title: displayId, reasonCode, rejectedAt };
}

describe("rejectedDistribution", () => {
  it("理由コードを enum 順に集計し、件数 0 のコードは落とす", () => {
    const dist = rejectedDistribution([
      rej("CND-1", "free_only"),
      rej("CND-2", "no_purchaser"),
      rej("CND-3", "no_purchaser"),
    ]);
    // enum 順（no_purchaser が free_only より前）。
    expect(dist.map((d) => d.code)).toEqual(["no_purchaser", "free_only"]);
    expect(dist.find((d) => d.code === "no_purchaser")?.count).toBe(2);
  });

  it("コード未設定（null）は末尾に「（コード未設定）」としてまとめる", () => {
    const dist = rejectedDistribution([rej("CND-1", null), rej("CND-2", "low_pain")]);
    expect(dist[dist.length - 1]).toEqual({ code: "uncoded", label: "（コード未設定）", count: 1 });
  });
});

describe("selectRejected（指摘①: 期間内棄却の絞り込み）", () => {
  const since = new Date("2026-06-11T00:00:00.000Z");
  const until = new Date("2026-06-18T00:00:00.000Z");

  it("rejectedAt が期間内の棄却だけを残す", () => {
    const picked = selectRejected(
      [
        rej("CND-IN", "no_purchaser", IN_PERIOD),
        rej("CND-OLD", "free_only", BEFORE_PERIOD),
      ],
      since,
      until,
    );
    expect(picked.map((r) => r.displayId)).toEqual(["CND-IN"]);
  });

  it("rejectedAt が null（時刻不明）は期間外として除外する", () => {
    const picked = selectRejected(
      [{ displayId: "CND-X", title: "x", reasonCode: "low_pain", rejectedAt: null }],
      since,
      until,
    );
    expect(picked).toEqual([]);
  });
});

describe("selectWatchlistChanges（指摘②: 期間内に動いた市場の絞り込み）", () => {
  const since = new Date("2026-06-11T00:00:00.000Z");
  const until = new Date("2026-06-18T00:00:00.000Z");

  function wl(overrides: Partial<WatchlistChange>): WatchlistChange {
    return {
      entityType: "ranking",
      entityName: "x",
      metricName: null,
      lastValue: "5",
      currentValue: "3",
      deltaFlag: "up",
      lastCheckedAt: IN_PERIOD,
      ...overrides,
    };
  }

  it("deltaFlag up/down かつ lastCheckedAt 期間内のものだけ残す", () => {
    const picked = selectWatchlistChanges(
      [
        wl({ entityName: "今週up", deltaFlag: "up", lastCheckedAt: IN_PERIOD }),
        wl({ entityName: "今週down", deltaFlag: "down", lastCheckedAt: IN_PERIOD }),
        wl({ entityName: "横ばい", deltaFlag: "unchanged", lastCheckedAt: IN_PERIOD }),
        wl({ entityName: "先週up", deltaFlag: "up", lastCheckedAt: BEFORE_PERIOD }),
        wl({ entityName: "未記録", deltaFlag: "up", lastCheckedAt: null }),
      ],
      since,
      until,
    );
    expect(picked.map((w) => w.entityName)).toEqual(["今週up", "今週down"]);
  });
});

describe("buildWeeklyReport", () => {
  it("ヘッダに期間（since 〜 until）を YYYY-MM-DD で出す", () => {
    const md = buildWeeklyReport(emptyData());
    expect(md).toContain("# Weekly Report");
    expect(md).toContain("- 期間: 2026-06-11 〜 2026-06-18");
  });

  it("全セクションが空なら各セクションの空メッセージを出す", () => {
    const md = buildWeeklyReport(emptyData());
    expect(md).toContain("## 今週追加した Raw Signal");
    expect(md).toContain("今週の追加はありません。");
    expect(md).toContain("スコアが上昇した候補はありません。");
    expect(md).toContain("スコアが低下した候補はありません。");
    expect(md).toContain("この期間の棄却はありません。");
    expect(md).toContain("差分のある観測対象はありません。");
  });

  it("スコア上昇/低下を snapshot 差分（movements）から出す", () => {
    const md = buildWeeklyReport(
      emptyData({
        scoreMovements: [
          { displayId: "CND-1", title: "請求書アプリ", before: 3, after: 4.5, delta: 1.5 },
          { displayId: "CND-2", title: "予約管理", before: 4, after: 2, delta: -2 },
        ],
      }),
    );
    expect(md).toContain("## スコア上昇（1 件）");
    expect(md).toContain("- CND-1 請求書アプリ: 3.0 → 4.5（+1.5）");
    expect(md).toContain("## スコア低下（1 件）");
    expect(md).toContain("- CND-2 予約管理: 4.0 → 2.0（-2.0）");
  });

  it("棄却理由コードの分布を期間内棄却の合計件数つきで出す（期間外は数えない）", () => {
    const md = buildWeeklyReport(
      emptyData({
        rejected: [
          rej("CND-1", "no_purchaser", IN_PERIOD),
          rej("CND-2", "no_purchaser", IN_PERIOD),
          rej("CND-3", "legal_risk", IN_PERIOD),
          rej("CND-OLD", "free_only", BEFORE_PERIOD), // 期間外 → 集計対象外
        ],
      }),
    );
    expect(md).toContain("## 棄却（理由コード分布・合計 3 件）");
    expect(md).toContain("- 購入者が不在（no_purchaser）: 2 件");
    expect(md).toContain("- 法務リスク（legal_risk）: 1 件");
    // 期間外の棄却（free_only）は出ない。
    expect(md).not.toContain("free_only");
  });

  it("期間内棄却が無ければ棄却セクションは空メッセージ（期間外だけのとき）", () => {
    const md = buildWeeklyReport(
      emptyData({ rejected: [rej("CND-OLD", "free_only", BEFORE_PERIOD)] }),
    );
    expect(md).toContain("## 棄却（理由コード分布）\nこの期間の棄却はありません。");
  });

  it("今週追加 Raw Signal を displayId・sourceType・対象つきで出し、長文は抜粋する", () => {
    const long = "あ".repeat(80);
    const md = buildWeeklyReport(
      emptyData({
        newRawSignals: [
          { displayId: "RS-1", sourceType: "review", observedEntity: "Acme App", summary: long },
        ],
      }),
    );
    expect(md).toContain("## 今週追加した Raw Signal（1 件）");
    expect(md).toContain("- RS-1 [review] Acme App — ");
    expect(md).toContain("…"); // 60 字超は省略記号で抜粋
  });

  it("Top100 入り / Top30 / 次に深掘り / Smoke Test 候補を候補参照で出す", () => {
    const md = buildWeeklyReport(
      emptyData({
        enteredTop100: [{ displayId: "CND-1", title: "昇格A" }],
        top30: [{ displayId: "CND-2", title: "上位B" }],
        digDeeper: [{ displayId: "CND-3", title: "仮説C" }],
        smokeTestCandidates: [{ displayId: "CND-4", title: "検証D" }],
      }),
    );
    expect(md).toContain("## Top100 入り（1 件）");
    expect(md).toContain("- CND-1 昇格A");
    expect(md).toContain("## Top30（1 件）");
    expect(md).toContain("- CND-2 上位B");
    expect(md).toContain("## 次に深掘り（1 件）");
    expect(md).toContain("- CND-3 仮説C");
    expect(md).toContain("## Smoke Test 候補（1 件）");
    expect(md).toContain("- CND-4 検証D");
  });

  it("来週見る市場は今週動いた Watchlist 差分だけを entityType / deltaFlag ラベルつきで出す", () => {
    const md = buildWeeklyReport(
      emptyData({
        watchlistChanges: [
          {
            entityType: "ranking",
            entityName: "総合ランキング",
            metricName: "順位",
            lastValue: "5",
            currentValue: "3",
            deltaFlag: "up",
            lastCheckedAt: IN_PERIOD,
          },
          {
            entityType: "ranking",
            entityName: "先週動いたきり",
            metricName: "順位",
            lastValue: "9",
            currentValue: "2",
            deltaFlag: "up",
            lastCheckedAt: BEFORE_PERIOD, // 期間外 → 再掲しない
          },
        ],
      }),
    );
    expect(md).toContain("## 来週見る市場（Watchlist 差分）（1 件）");
    expect(md).toContain("- [ランキング] 総合ランキング: 順位 5 → 3（↑ 上昇）");
    // 期間外（先週動いたきり）は毎週再掲しない（指摘②）。
    expect(md).not.toContain("先週動いたきり");
  });
});
