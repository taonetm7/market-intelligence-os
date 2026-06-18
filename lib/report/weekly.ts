// Weekly Report 生成 — task-38, spec v2 §9.9。
//
// ScoreSnapshot の週次差分（task-28 weekDelta）と DecisionLog（task-29）、棄却理由コード
// （Candidate.rejectedReasonCode）、Watchlist 差分（task-36 deltaFlag）から週次レポートの
// Markdown 文字列を生成する **純粋関数**。DB/Prisma には依存せず、必要なフィールドだけを受ける
// 構造的な入力型（WeeklyReportData）を取る（candidateMarkdown.ts と同じ流儀）。データ収集と HTTP
// 翻訳は呼び出し側（API route）の責務。
//
// §9.9 のセクション:
//   今週追加 Raw Signal / Top100 入り / スコア上昇 / スコア低下 / 要追加調査 /
//   棄却（理由コード分布）/ Top30 / 次に深掘り / Smoke Test 候補 / 来週見る市場（Watchlist 差分）。
//
// 「上昇/低下」の振り分け・棄却理由コードの集計・差分の整形といった判定はすべてこの純粋関数側に
// 寄せ、route/page は薄く保つ（テストはこの関数を直接駆動して各セクションの生成を検証する）。
//
// enum 文字列は直書きせず、表示ラベルは enum 値タプル（task-02 / lib/validation/enums.ts）をキーに
// した対応表で引く。集計の反復も値タプルを巡回して安定順にする。

import {
  DELTA_FLAG_VALUES,
  REJECTED_REASON_CODE_VALUES,
  WATCHLIST_ENTITY_TYPE_VALUES,
  type DeltaFlag,
  type RejectedReasonCode,
  type WatchlistEntityType,
} from "../validation/enums";

// ---------------------------------------------------------------------------
// 表示ラベル（enum 値 → 日本語）。enum 値タプルをキーにするので網羅性は型で担保される。
// ---------------------------------------------------------------------------

/** 棄却理由コードの表示ラベル（§15.1 の傾向分析を読みやすくする）。 */
export const REJECTED_REASON_CODE_LABELS: Record<RejectedReasonCode, string> = {
  no_purchaser: "購入者が不在",
  free_only: "無料で足りる",
  legal_risk: "法務リスク",
  too_competitive: "競合過多",
  weak_mobile_need: "モバイル需要が弱い",
  high_ai_cost: "AI コスト高",
  untestable: "検証不能",
  low_pain: "痛みが小さい",
  no_form_fit: "プロダクト形態が合わない",
};

/** deltaFlag の表示（矢印＋ラベル）。 */
export const DELTA_FLAG_LABELS: Record<DeltaFlag, string> = {
  up: "↑ 上昇",
  down: "↓ 下降",
  unchanged: "→ 横ばい",
  unknown: "— 不明",
};

/** Watchlist entityType の表示ラベル。 */
export const ENTITY_TYPE_LABELS: Record<WatchlistEntityType, string> = {
  competitor_app: "競合アプリ",
  keyword: "キーワード",
  ranking: "ランキング",
  template_sale: "テンプレ販売",
  outsource_category: "外注カテゴリ",
  regulation_page: "法改正ページ",
  plugin: "プラグイン",
};

// ---------------------------------------------------------------------------
// 入力型（構造的・Prisma 非依存）
// ---------------------------------------------------------------------------

/** 候補への最小参照（表示用）。 */
export interface ReportCandidateRef {
  displayId: string;
  title: string;
}

/** スコア変動 1 件（snapshot 差分由来）。delta = after - before。 */
export interface ScoreMovement extends ReportCandidateRef {
  before: number;
  after: number;
  delta: number;
}

/** 棄却 1 件（理由コードは未設定があり得る＝自由文のみで棄却した場合）。 */
export interface RejectedEntry extends ReportCandidateRef {
  reasonCode: string | null;
}

/** 今週追加された Raw Signal 1 件。 */
export interface NewRawSignalEntry {
  displayId: string;
  sourceType: string;
  observedEntity: string | null;
  summary: string;
}

/** Watchlist の差分 1 件（来週見る市場）。 */
export interface WatchlistChange {
  entityType: string;
  entityName: string;
  metricName: string | null;
  lastValue: string | null;
  currentValue: string | null;
  deltaFlag: string;
}

/**
 * 週報生成の入力一式。route が repository から集めて組み立てる。
 * 「上昇/低下」は scoreMovements を delta 符号でこの関数が振り分けるため、route は変動候補を
 * 1 本のリストで渡せばよい（delta===0 は除外される）。
 */
export interface WeeklyReportData {
  since: Date;
  until: Date;
  newRawSignals: NewRawSignalEntry[];
  enteredTop100: ReportCandidateRef[];
  scoreMovements: ScoreMovement[];
  needsInvestigation: ReportCandidateRef[];
  rejected: RejectedEntry[];
  top30: ReportCandidateRef[];
  digDeeper: ReportCandidateRef[];
  smokeTestCandidates: ReportCandidateRef[];
  watchlistChanges: WatchlistChange[];
}

// ---------------------------------------------------------------------------
// 整形ヘルパ
// ---------------------------------------------------------------------------

/** Date → "YYYY-MM-DD"（UTC 基準・週報の期間表示用）。 */
function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** スコアを小数 1 桁へ。 */
function score(value: number): string {
  return value.toFixed(1);
}

/** 符号付きの差分表記（+1.0 / -1.0）。 */
function signed(delta: number): string {
  const body = Math.abs(delta).toFixed(1);
  return delta > 0 ? `+${body}` : `-${body}`;
}

/** 候補参照を "CND-001 タイトル" の 1 行へ。 */
function refLine(ref: ReportCandidateRef): string {
  return `- ${ref.displayId} ${ref.title}`;
}

/**
 * セクションを組み立てる。行があれば見出し＋件数＋箇条書き、無ければ見出し＋空メッセージ。
 * 見出しには件数を併記する（行がある場合のみ）。
 */
function section(title: string, lines: string[], emptyText: string): string {
  if (lines.length === 0) return `## ${title}\n${emptyText}`;
  return `## ${title}（${lines.length} 件）\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// 各セクションの行生成
// ---------------------------------------------------------------------------

function rawSignalLines(entries: NewRawSignalEntry[]): string[] {
  return entries.map((e) => {
    const entity = e.observedEntity?.trim();
    const head = entity && entity.length > 0 ? entity : "（対象未記入）";
    const summary = e.summary.trim().replace(/\s+/g, " ");
    const excerpt = summary.length > 60 ? `${summary.slice(0, 60)}…` : summary;
    return `- ${e.displayId} [${e.sourceType}] ${head} — ${excerpt}`;
  });
}

/** スコア変動を delta 符号で上昇/低下へ振り分ける（delta===0 は除外）。 */
export function splitMovements(movements: ScoreMovement[]): {
  up: ScoreMovement[];
  down: ScoreMovement[];
} {
  const up = movements.filter((m) => m.delta > 0).sort((a, b) => b.delta - a.delta);
  const down = movements.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta);
  return { up, down };
}

function movementLine(m: ScoreMovement): string {
  return `- ${m.displayId} ${m.title}: ${score(m.before)} → ${score(m.after)}（${signed(m.delta)}）`;
}

/**
 * 棄却理由コードの分布を集計する（§15.1）。enum 値タプルを巡回して安定順に並べ、件数 0 のコードは
 * 落とす。コード未設定（自由文のみの棄却）は末尾に「（コード未設定）」としてまとめる。
 */
export function rejectedDistribution(
  rejected: RejectedEntry[],
): { code: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  let noCode = 0;
  for (const r of rejected) {
    if (r.reasonCode === null || r.reasonCode === "") {
      noCode += 1;
      continue;
    }
    counts.set(r.reasonCode, (counts.get(r.reasonCode) ?? 0) + 1);
  }
  const rows: { code: string; label: string; count: number }[] = REJECTED_REASON_CODE_VALUES.filter(
    (code) => counts.has(code),
  ).map((code) => ({
    code,
    label: REJECTED_REASON_CODE_LABELS[code],
    count: counts.get(code)!,
  }));
  if (noCode > 0) {
    rows.push({ code: "uncoded", label: "（コード未設定）", count: noCode });
  }
  return rows;
}

function watchlistLine(w: WatchlistChange): string {
  const typeLabel =
    (WATCHLIST_ENTITY_TYPE_VALUES as readonly string[]).includes(w.entityType) &&
    w.entityType in ENTITY_TYPE_LABELS
      ? ENTITY_TYPE_LABELS[w.entityType as WatchlistEntityType]
      : w.entityType;
  const flagLabel =
    (DELTA_FLAG_VALUES as readonly string[]).includes(w.deltaFlag) && w.deltaFlag in DELTA_FLAG_LABELS
      ? DELTA_FLAG_LABELS[w.deltaFlag as DeltaFlag]
      : w.deltaFlag;
  const metric = w.metricName?.trim();
  const metricPart = metric && metric.length > 0 ? `${metric} ` : "";
  const last = w.lastValue?.trim() || "—";
  const current = w.currentValue?.trim() || "—";
  return `- [${typeLabel}] ${w.entityName}: ${metricPart}${last} → ${current}（${flagLabel}）`;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * 週報の対象期間。until を基準に since = until - 7 日 を返す（route の既定期間に使う純関数）。
 */
export function weeklyReportRange(until: Date): { since: Date; until: Date } {
  const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { since, until };
}

/**
 * WeeklyReportData を §9.9 の週報 Markdown 文字列へ変換する（純粋関数）。
 * 見出し構成は固定。各セクションは該当が無ければ空メッセージを出す。
 */
export function buildWeeklyReport(data: WeeklyReportData): string {
  const { up, down } = splitMovements(data.scoreMovements);
  const distribution = rejectedDistribution(data.rejected);

  const distributionBlock =
    distribution.length === 0
      ? "## 棄却（理由コード分布）\nこの期間の棄却はありません。"
      : [
          `## 棄却（理由コード分布・合計 ${data.rejected.length} 件）`,
          ...distribution.map((d) => `- ${d.label}（${d.code}）: ${d.count} 件`),
        ].join("\n");

  const blocks = [
    "# Weekly Report",
    `- 期間: ${ymd(data.since)} 〜 ${ymd(data.until)}`,
    "",
    section("今週追加した Raw Signal", rawSignalLines(data.newRawSignals), "今週の追加はありません。"),
    "",
    section("Top100 入り", data.enteredTop100.map(refLine), "今週 Top100 入りした候補はありません。"),
    "",
    section("スコア上昇", up.map(movementLine), "スコアが上昇した候補はありません。"),
    "",
    section("スコア低下", down.map(movementLine), "スコアが低下した候補はありません。"),
    "",
    section(
      "要追加調査",
      data.needsInvestigation.map(refLine),
      "追加調査が必要な候補はありません。",
    ),
    "",
    distributionBlock,
    "",
    section("Top30", data.top30.map(refLine), "Top30 の候補はありません。"),
    "",
    section("次に深掘り", data.digDeeper.map(refLine), "次に深掘りする候補はありません。"),
    "",
    section(
      "Smoke Test 候補",
      data.smokeTestCandidates.map(refLine),
      "Smoke Test 候補はありません。",
    ),
    "",
    section(
      "来週見る市場（Watchlist 差分）",
      data.watchlistChanges.map(watchlistLine),
      "差分のある観測対象はありません。",
    ),
    "",
  ];
  return blocks.join("\n");
}
