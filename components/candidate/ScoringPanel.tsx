"use client";

import { useState } from "react";

import { Badge, Button, type BadgeTone } from "../ui";

// task-21 — Scoring パネル（spec v2 §8.1 / §8.2 / §9.5）。
// 素点（0〜5）を入力 → 保存で task-13 の POST /api/scoring/initial/[candidateId] を呼び、
// 返ってきた InitialScore / confidence / Top100 ゲート可否（pass + reasons）を表示する。
// さらに「進級可否パネル」として、ゲートの不足条件（reasons）と、そこから導く
// 「次に取るべき Evidence / アクション」を併置する（§9.5: 判断の文脈を割らない）。
//
// 設計（既存 UI の流儀）:
//   ロジック（入力組立・送信・進級アドバイス導出）は純関数として切り出し、依存追加なしの
//   node テストで直接駆動する。表示は state を持たないビューに分け、renderToStaticMarkup で
//   検証する。フォーム本体だけが local state を持つ。
//
// 素点は §8.1 の市場デマンド6軸（spend/dissatisfaction/pain/frequency/discoverability/
// substitute）に加え、Top100 ゲート（§8.2）のバイナリ条件に使う legalRisk / opsRisk を採る。
// scoring/initial の入力スキーマ（initialInputsSchema）は8項目すべてを必須とするため、
// リスク2軸も同じフォームで入力する（§8.1 注: リスクは市場スコアには加えず、ゲートで扱う）。

/** 素点1軸の定義（key は initialInputsSchema のフィールド名と一致させる）。 */
export type ScoreAxis = { key: string; label: string; hint: string };

/** §8.1 市場デマンドの素点6軸（InitialScore に重み付き合計される）。 */
export const MARKET_AXES: ScoreAxis[] = [
  { key: "spend", label: "Spend（既存支出）", hint: "サブスク/外注/テンプレ/講座/SaaS 費など既存の支出" },
  { key: "dissatisfaction", label: "Dissatisfaction（競合不満）", hint: "既存手段への不満の強さ" },
  { key: "pain", label: "Pain（痛みの強さ）", hint: "損失・時間浪費・ストレスの大きさ" },
  { key: "frequency", label: "Frequency（頻度）", hint: "発生頻度（日/週/月）" },
  { key: "discoverability", label: "Discoverability（到達性）", hint: "検索・ASO・SNS・コミュニティで届くか" },
  { key: "substitute", label: "Substitute（代替の面倒さ）", hint: "Excel/紙/手作業/外注など現代替手段の面倒さ" },
];

/** Top100 ゲート（§8.2）のバイナリ条件に使うリスク2軸（市場スコアには加算しない）。 */
export const RISK_AXES: ScoreAxis[] = [
  { key: "legalRisk", label: "legalRisk（法務リスク）", hint: "規制・法務・ポリシーのリスク（高いとゲート不可）" },
  { key: "opsRisk", label: "opsRisk（運用リスク）", hint: "運用の重さ・リスク（高いとゲート不可）" },
];

/** initialInputsSchema が要求する素点8キー（送信ペイロードの完全性を担保する）。 */
export const INITIAL_INPUT_KEYS = [
  ...MARKET_AXES.map((a) => a.key),
  ...RISK_AXES.map((a) => a.key),
] as const;

/** フォームが保持する素点（軸 key → 0〜5）。未入力は 0。 */
export type ScoreValues = Partial<Record<string, number>>;

/** scoring/initial が返すゲート判定（evaluateTop100Gate と同形）。 */
export type GateResult = { pass: boolean; reasons: string[] };

/** scoring/initial の計算結果（表示に使う部分）。 */
export type ScoringResult = {
  initialScore: number;
  confidence: number;
  gate: GateResult;
};

/** 素点を 0〜5 の整数へ丸める（範囲外・NaN は 0／5 にクランプ）。 */
function clampScore(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.min(5, Math.max(0, Math.round(value)));
}

/**
 * フォーム値から scoring/initial の入力ペイロード（8素点）を組み立てる。
 * 欠けたキーは 0 で埋め、initialInputsSchema（各 0〜5 必須）を満たす完全な形にする。
 */
export function buildInitialInputs(values: ScoreValues): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of INITIAL_INPUT_KEYS) {
    out[key] = clampScore(values[key]);
  }
  return out;
}

/** scoring/initial の endpoint（path の [candidateId] に id を入れる）。 */
export function scoringEndpoint(candidateId: string): string {
  return `/api/scoring/initial/${candidateId}`;
}

/**
 * 素点を計算・保存する（POST scoring/initial）。fetcher は DI 可能（テストで差し替える）。
 * 返却は InitialScore / confidence / Top100 ゲート可否。!ok は throw（呼び出し側で握る）。
 */
export async function submitScoring(
  candidateId: string,
  values: ScoreValues,
  fetcher: typeof fetch = fetch,
): Promise<ScoringResult> {
  const res = await fetcher(scoringEndpoint(candidateId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildInitialInputs(values)),
  });
  if (!res.ok) {
    throw new Error(`スコアの計算・保存に失敗しました（${res.status}）`);
  }
  const body = (await res.json()) as { data?: ScoringResult };
  if (!body.data) {
    throw new Error("スコア計算の応答が不正です");
  }
  return body.data;
}

/** 進級可否アドバイス。blockers＝不足条件（reasons）、nextSteps＝次に取るべき Evidence/操作。 */
export type PromotionAdvice = {
  pass: boolean;
  blockers: string[];
  nextSteps: string[];
};

/**
 * Top100 ゲート結果から「進級可否パネル」の表示内容を導く（§9.5）。
 * blockers はゲートの不足条件（reasons）をそのまま使う。nextSteps は各 reason の種別に応じて
 * 「次に取るべき Evidence / アクション」へ翻訳する（同種の重複は1つに畳む）。
 */
export function buildPromotionAdvice(gate: GateResult): PromotionAdvice {
  const nextSteps: string[] = [];
  const add = (step: string) => {
    if (!nextSteps.includes(step)) nextSteps.push(step);
  };
  for (const reason of gate.reasons) {
    if (reason.includes("独立チャネル")) {
      add("別の sourceType（独立チャネル）の Evidence を追加して distinct ソース数を増やす");
    } else if (reason.includes("強シグナル")) {
      add("spend / dissatisfaction / search のいずれかの強シグナル Evidence を追加する");
    } else if (reason.includes("InitialScore")) {
      add("市場素点（Spend / Dissatisfaction 等）を見直すか、支出・不満の Evidence を増やす");
    } else if (reason.includes("legalRisk")) {
      add("法務・ポリシーリスクを下げる根拠を確認する（現状は昇格不可水準）");
    } else if (reason.includes("opsRisk")) {
      add("運用リスクを下げる根拠を確認する（現状は昇格不可水準）");
    }
  }
  return { pass: gate.pass, blockers: gate.reasons, nextSteps };
}

/** confidence(0..1) → バッジ色（CandidateTable と同じ閾値で併置の一貫性を保つ）。 */
export function confidenceTone(confidence: number): BadgeTone {
  if (confidence >= 0.66) return "success";
  if (confidence >= 0.33) return "info";
  return "warning";
}

const SECTION_STYLE = { marginTop: 16 } as const;
const LABEL_STYLE = { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 } as const;
const HINT_STYLE = { fontSize: 12, color: "#667085" } as const;
const LIST_STYLE = { margin: "4px 0 0", paddingLeft: 20, fontSize: 13 } as const;

export type ScoringResultViewProps = { result: ScoringResult };

/**
 * 計算結果＋進級可否パネル（表示専用）。スコアと confidence を別次元として併置し
 * （§9.5 pseudo-science 化の抑制）、ゲート可否・不足条件・次アクションを示す。
 */
export function ScoringResultView({ result }: ScoringResultViewProps) {
  const advice = buildPromotionAdvice(result.gate);
  return (
    <div style={SECTION_STYLE} aria-label="スコア計算結果">
      <div style={{ display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap" }}>
        <span>
          <strong>InitialScore</strong>: {result.initialScore.toFixed(1)} / 100
        </span>
        <span>
          <strong>確信度</strong>{" "}
          <Badge tone={confidenceTone(result.confidence)}>{result.confidence.toFixed(2)}</Badge>
        </span>
        <span>
          <strong>Top100 ゲート</strong>{" "}
          {advice.pass ? (
            <Badge tone="success">通過</Badge>
          ) : (
            <Badge tone="warning">未通過</Badge>
          )}
        </span>
      </div>

      {advice.pass ? (
        <p style={{ ...HINT_STYLE, marginTop: 8 }}>
          Top100 進級ゲートを満たしています。promote で normalized → top100 へ昇格できます。
        </p>
      ) : (
        <div style={{ marginTop: 8 }}>
          <div>
            <span style={LABEL_STYLE}>不足している条件</span>
            <ul style={LIST_STYLE} aria-label="不足している条件">
              {advice.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
          {advice.nextSteps.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <span style={LABEL_STYLE}>次に取るべき Evidence / アクション</span>
              <ul style={LIST_STYLE} aria-label="次に取るべきアクション">
                {advice.nextSteps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export type ScoringPanelProps = {
  candidateId: string;
  /** 既存の素点（candidate.initialInputs）。再採点時のプレフィルに使う。 */
  initialValues?: ScoreValues;
  /** 保存（計算）成功時に呼ばれる（親で候補を再取得して stage/score を反映する）。 */
  onScored?: (result: ScoringResult) => void;
};

/**
 * Scoring パネル本体（フォーム）。素点8軸を入力 → 保存で計算 API を叩き、結果と
 * 進級可否を表示する。送信ロジックは submitScoring（純関数）に委譲する。
 */
export function ScoringPanel({ candidateId, initialValues, onScored }: ScoringPanelProps) {
  const [values, setValues] = useState<ScoreValues>(initialValues ?? {});
  const [result, setResult] = useState<ScoringResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(key: string, raw: string) {
    const next = raw === "" ? undefined : Number(raw);
    setValues((prev) => ({ ...prev, [key]: next }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const scored = await submitScoring(candidateId, values);
      setResult(scored);
      onScored?.(scored);
    } catch (e) {
      setError(e instanceof Error ? e.message : "スコアの計算・保存に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  const renderAxis = (axis: ScoreAxis) => (
    <label key={axis.key} style={{ display: "block", marginBottom: 10 }}>
      <span style={LABEL_STYLE}>{axis.label}</span>
      <input
        className="mi-input"
        type="number"
        min={0}
        max={5}
        step={1}
        value={values[axis.key] ?? ""}
        onChange={(e) => update(axis.key, e.target.value)}
        placeholder="0〜5"
        style={{ width: 96 }}
      />
      <span style={{ ...HINT_STYLE, marginLeft: 8 }}>{axis.hint}</span>
    </label>
  );

  return (
    <section aria-label="Scoring パネル">
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Scoring（初期スコア）</h2>
      <form onSubmit={handleSubmit} noValidate>
        <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
          <legend style={{ ...LABEL_STYLE, fontSize: 14 }}>市場デマンド（各 0〜5）</legend>
          {MARKET_AXES.map(renderAxis)}
        </fieldset>
        <fieldset style={{ border: "none", margin: "8px 0 0", padding: 0 }}>
          <legend style={{ ...LABEL_STYLE, fontSize: 14 }}>
            リスク（Top100 ゲートのバイナリ条件・各 0〜5）
          </legend>
          {RISK_AXES.map(renderAxis)}
        </fieldset>

        <div style={{ marginTop: 12 }}>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "計算中…" : "保存して計算"}
          </Button>
        </div>
      </form>

      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13, marginTop: 8 }}>
          {error}
        </p>
      ) : null}
      {result ? <ScoringResultView result={result} /> : null}
    </section>
  );
}
