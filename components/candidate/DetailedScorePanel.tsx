"use client";

import { useCallback, useRef, useState } from "react";

import { Badge, Button, Select, type BadgeTone, type SelectOption } from "../ui";
import { confidenceTone } from "./CandidateTable";
import { promoteCandidate } from "./PromoteRejectModal";

// task-31 — 詳細スコアパネル（spec v2 §8.4 / §8.5 / §8.6 / §8.7 / §8.9 / §9.5）。
// 詳細素点12軸（各 0〜5）＋不確実性レベルを入力 → 保存で POST /api/scoring/detailed/[candidateId]
// （task-30）を呼び、DetailedScore / SignalBonus / UncertaintyPenalty / TotalForGate / confidence と
// Top30 進級ゲート（§8.7）の pass/reasons を「進級可否」として表示する。ゲート通過時のみ promote
// （POST /promote・top100→top30）を有効化し、未通過なら不足理由を併置する（§9.5: 文脈を割らない）。
//
// 設計（既存 ScoringPanel の流儀）: 入力組立・送信・進級アドバイス導出は純関数（fetcher DI）に
// 切り出し、表示は state を持たないビューに分け renderToStaticMarkup で検証する。フォーム本体だけが
// local state を持つ。自動計算の境界はサーバ側（§8.9）で、ここは素点とレベルを渡し結果を見せるだけ。

/** 詳細素点1軸の定義（key は detailed API の入力スキーマと一致させる）。 */
export type DetailedAxis = { key: string; label: string; hint: string };

/** §8.4 詳細スコアの12軸（各 0〜5）。key は scoring/detailed の detailedRequestSchema と一致。 */
export const DETAILED_AXES: DetailedAxis[] = [
  { key: "spend", label: "Spend（支出規模）", hint: "既存の支出の大きさ" },
  { key: "wtp", label: "WTP（支払意欲）", hint: "対価を払う意欲の強さ" },
  { key: "acquisition", label: "Acquisition（獲得性）", hint: "ユーザー獲得のしやすさ" },
  { key: "pain", label: "Pain（痛み）", hint: "課題の痛みの強さ" },
  { key: "frequency", label: "Frequency（頻度）", hint: "発生頻度" },
  { key: "retention", label: "Retention（継続性）", hint: "使い続けられるか" },
  { key: "competitorPain", label: "CompetitorPain（競合不満）", hint: "競合への不満の強さ" },
  { key: "differentiation", label: "Differentiation（差別化）", hint: "差別化の余地" },
  { key: "formFit", label: "FormFit（形態適合）", hint: "プロダクト形態との適合" },
  { key: "pfFit", label: "PfFit（PF 適合）", hint: "プラットフォーム適合" },
  { key: "buildEase", label: "BuildEase（作りやすさ）", hint: "実装の容易さ" },
  { key: "legalSafety", label: "LegalSafety（法務安全性）", hint: "規制・法務の安全性" },
];

/** 詳細素点の全 key（送信ペイロードの完全性を担保する）。 */
export const DETAILED_INPUT_KEYS = DETAILED_AXES.map((a) => a.key);

/** 不確実性レベル（§8.5・人間判断）。スコアリング内部のカテゴリ。 */
export type UncertaintyLevel = "enough" | "mixed" | "unconfirmed";
export const UNCERTAINTY_OPTIONS: SelectOption[] = [
  { value: "enough", label: "十分（ペナルティなし）" },
  { value: "mixed", label: "混在（中程度のペナルティ）" },
  { value: "unconfirmed", label: "未確認（大きいペナルティ）" },
];

/** フォームが保持する素点（軸 key → 0〜5）。未入力は 0。 */
export type DetailedValues = Partial<Record<string, number>>;

/** detailed API が返すゲート判定（evaluateTop30Gate と同形）。 */
export type GateResult = { pass: boolean; reasons: string[] };

/** detailed API の計算結果（表示に使う部分）。 */
export type DetailedScoringResult = {
  detailedScore: number;
  signalBonus: number;
  uncertaintyPenalty: number;
  totalForGate: number;
  confidence: number;
  gate: GateResult;
};

/** 素点を 0〜5 の整数へ丸める（範囲外・NaN は 0／5 にクランプ）。 */
function clampScore(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.min(5, Math.max(0, Math.round(value)));
}

/**
 * フォーム値から detailed API の入力ペイロード（12素点＋レベル）を組み立てる。
 * 欠けたキーは 0 で埋め、detailedRequestSchema（各 0〜5 必須）を満たす完全な形にする。
 */
export function buildDetailedInputs(
  values: DetailedValues,
  level: UncertaintyLevel,
): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const key of DETAILED_INPUT_KEYS) {
    out[key] = clampScore(values[key]);
  }
  out.uncertaintyLevel = level;
  return out;
}

/** scoring/detailed の endpoint。 */
export function detailedEndpoint(candidateId: string): string {
  return `/api/scoring/detailed/${candidateId}`;
}

/**
 * 詳細スコアを計算・保存する（POST scoring/detailed）。fetcher は DI 可能。
 * 返却は DetailedScore 一式＋ Top30 ゲート可否。!ok は throw（呼び出し側で握る）。
 */
export async function submitDetailedScore(
  candidateId: string,
  values: DetailedValues,
  level: UncertaintyLevel,
  fetcher: typeof fetch = fetch,
): Promise<DetailedScoringResult> {
  const res = await fetcher(detailedEndpoint(candidateId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildDetailedInputs(values, level)),
  });
  if (!res.ok) {
    throw new Error(`詳細スコアの計算・保存に失敗しました（${res.status}）`);
  }
  const body = (await res.json()) as { data?: DetailedScoringResult };
  if (!body.data) {
    throw new Error("詳細スコア計算の応答が不正です");
  }
  return body.data;
}

/** 進級可否アドバイス。blockers＝Top30 不足条件、nextSteps＝次に取るべき手当て。 */
export type Top30Advice = {
  pass: boolean;
  blockers: string[];
  nextSteps: string[];
};

/**
 * Top30 ゲート結果から「進級可否パネル」の表示内容を導く（§9.5）。
 * blockers はゲートの不足条件（reasons）をそのまま使う。nextSteps は reason の種別に応じて
 * 「次に取るべき手当て」へ翻訳する（同種の重複は1つに畳む）。
 */
export function buildTop30Advice(gate: GateResult): Top30Advice {
  const nextSteps: string[] = [];
  const add = (step: string) => {
    if (!nextSteps.includes(step)) nextSteps.push(step);
  };
  for (const reason of gate.reasons) {
    if (reason.includes("独立チャネル")) {
      add("別の sourceType（独立チャネル）の Evidence を追加して distinct ソース数を増やす");
    } else if (reason.includes("確信度") || reason.includes("confidence")) {
      add("直接支出/最新観測など確信度を上げる Evidence を補強する");
    } else if (reason.includes("検証") || reason.includes("testable")) {
      add("検証可能日数（testableWithinDays）を見直し、短期で検証できる設計にする");
    } else if (reason.includes("TotalForGate") || reason.includes("合計") || reason.includes("スコア")) {
      add("詳細素点（Spend / Pain など）や SignalBonus の根拠を見直す");
    } else {
      add(reason);
    }
  }
  return { pass: gate.pass, blockers: gate.reasons, nextSteps };
}

const SECTION_STYLE = { marginTop: 16 } as const;
const LABEL_STYLE = { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 } as const;
const HINT_STYLE = { fontSize: 12, color: "#667085" } as const;
const LIST_STYLE = { margin: "4px 0 0", paddingLeft: 20, fontSize: 13 } as const;

/** ゲート可否バッジ色。 */
function gateTone(pass: boolean): BadgeTone {
  return pass ? "success" : "warning";
}

export type DetailedScoreResultViewProps = { result: DetailedScoringResult };

/**
 * 詳細計算結果＋ Top30 進級可否（表示専用）。スコア・ボーナス・ペナルティ・confidence を併置し
 * （§9.5: 評価を 1 つの数字に潰さない）、ゲート可否・不足条件・次手当てを示す。
 */
export function DetailedScoreResultView({ result }: DetailedScoreResultViewProps) {
  const advice = buildTop30Advice(result.gate);
  return (
    <div style={SECTION_STYLE} aria-label="詳細スコア計算結果">
      <div style={{ display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap" }}>
        <span>
          <strong>DetailedScore</strong>: {result.detailedScore.toFixed(1)}
        </span>
        <span>
          <strong>SignalBonus</strong>: {result.signalBonus.toFixed(1)}
        </span>
        <span>
          <strong>UncertaintyPenalty</strong>: {result.uncertaintyPenalty.toFixed(1)}
        </span>
        <span>
          <strong>TotalForGate</strong>: {result.totalForGate.toFixed(1)}
        </span>
        <span>
          <strong>確信度</strong>{" "}
          <Badge tone={confidenceTone(result.confidence)}>{result.confidence.toFixed(2)}</Badge>
        </span>
        <span>
          <strong>Top30 ゲート</strong>{" "}
          <Badge tone={gateTone(advice.pass)}>{advice.pass ? "通過" : "未通過"}</Badge>
        </span>
      </div>

      {advice.pass ? (
        <p style={{ ...HINT_STYLE, marginTop: 8 }}>
          Top30 進級ゲートを満たしています。promote で top100 → top30 へ昇格できます。
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
              <span style={LABEL_STYLE}>次に取るべき手当て</span>
              <ul style={LIST_STYLE} aria-label="次に取るべき手当て">
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

export type DetailedScorePanelProps = {
  candidateId: string;
  /** 既存の詳細素点（プレフィルに使う）。 */
  initialValues?: DetailedValues;
  /** 詳細採点 / 昇格の成功時に呼ばれる（親で履歴・判断ログ・プロットを取り直す）。 */
  onChanged?: () => void;
};

/**
 * 詳細スコアパネル本体（フォーム）。12素点＋レベルを入力 → 保存で detailed API を叩き、結果と
 * Top30 進級可否を表示する。ゲート通過時のみ promote を有効化する（未通過は理由を併置）。
 */
export function DetailedScorePanel({ candidateId, initialValues, onChanged }: DetailedScorePanelProps) {
  const [values, setValues] = useState<DetailedValues>(initialValues ?? {});
  const [level, setLevel] = useState<UncertaintyLevel>("enough");
  const [result, setResult] = useState<DetailedScoringResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [promoting, setPromoting] = useState(false);
  // 最新の計算リクエストだけ採用する連番ガード（ScoringPanel と同じ流儀）。
  const seqRef = useRef(0);

  function update(key: string, raw: string) {
    const next = raw === "" ? undefined : Number(raw);
    setValues((prev) => ({ ...prev, [key]: next }));
  }

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) return;
      const seq = (seqRef.current += 1);
      setSubmitting(true);
      setError(null);
      setNotice(null);
      try {
        const scored = await submitDetailedScore(candidateId, values, level);
        if (seq !== seqRef.current) return;
        setResult(scored);
        onChanged?.();
      } catch (e) {
        if (seq !== seqRef.current) return;
        setError(e instanceof Error ? e.message : "詳細スコアの計算・保存に失敗しました");
      } finally {
        if (seq === seqRef.current) setSubmitting(false);
      }
    },
    [candidateId, values, level, submitting, onChanged],
  );

  // promote（top100 → top30）。Top30 ゲート通過時のみ有効。未達は API が 422＋理由を返す。
  const handlePromote = useCallback(async () => {
    if (promoting) return;
    setPromoting(true);
    setError(null);
    setNotice(null);
    try {
      await promoteCandidate(candidateId);
      setNotice("top30 へ昇格しました");
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "昇格に失敗しました");
    } finally {
      setPromoting(false);
    }
  }, [candidateId, promoting, onChanged]);

  const canPromote = result?.gate.pass === true;

  const renderAxis = (axis: DetailedAxis) => (
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
    <section aria-label="詳細スコアパネル">
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>詳細スコア（Top30 進級）</h2>
      <form onSubmit={(e) => void handleSubmit(e)} noValidate>
        <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
          <legend style={{ ...LABEL_STYLE, fontSize: 14 }}>詳細12軸（各 0〜5）</legend>
          {DETAILED_AXES.map(renderAxis)}
        </fieldset>
        <label style={{ display: "block", margin: "8px 0 0" }}>
          <span style={LABEL_STYLE}>不確実性レベル（§8.5・人間判断）</span>
          <Select
            options={UNCERTAINTY_OPTIONS}
            value={level}
            onChange={(e) => setLevel(e.target.value as UncertaintyLevel)}
          />
        </label>

        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "計算中…" : "保存して計算"}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => void handlePromote()}
            disabled={!canPromote || promoting}
          >
            {promoting ? "昇格中…" : "promote（top30 へ）"}
          </Button>
        </div>
      </form>

      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13, marginTop: 8 }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" style={{ color: "#1a7f3c", fontSize: 13, marginTop: 8 }}>
          {notice}
        </p>
      ) : null}
      {result ? <DetailedScoreResultView result={result} /> : null}
    </section>
  );
}
