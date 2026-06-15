"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Badge, type BadgeTone } from "../ui";
import { candidateEndpoint, createLatestGuard } from "./CandidateDetail";
import { confidenceTone, formatConfidence, formatScore, stageTone } from "./CandidateTable";

// task-31 — score × confidence 2軸ビュー（spec v2 §8.4 注記 / §9.5）。
// 横=score・縦=confidence の格子に候補をプロットし、「スコアが高くても確信度が低い」候補を
// 視覚的に分離する（スコア単独過信＝pseudo-science 化の抑制・§8.4/§9.5）。候補一覧（将来タスク）
// でも再利用できるよう、プロット対象は points 配列で受ける純粋なビューにする。
//
// 設計（既存 UI の流儀）: 配置計算（score/confidence → セル座標）は純関数として切り出し、
// 依存追加なしの node テストで駆動する。表示は state を持たないビューに分け renderToStaticMarkup
// で検証する。詳細画面用に「当該候補1件を取得してプロットする」コンテナも併せて持つ。

/** プロット対象の 1 点。score は 0〜100・confidence は 0〜1（未採点は null＝未配置）。 */
export type MatrixPoint = {
  id: string;
  label: string;
  score: number | null;
  confidence: number | null;
  /** マーカー色（stage 由来など）。既定は info。 */
  tone?: BadgeTone;
};

/** 格子の分割数（既定 5×5）。 */
export type MatrixDims = { cols: number; rows: number };
export const DEFAULT_DIMS: MatrixDims = { cols: 5, rows: 5 };

/** セル座標（左上が (col=0,row=0)）。 */
export type MatrixCell = { col: number; row: number };

/** score(0〜100) → 列 index（0=低スコア・左）。範囲外はクランプ。 */
export function scoreToColumn(score: number, cols: number = DEFAULT_DIMS.cols): number {
  const clamped = Math.min(100, Math.max(0, score));
  return Math.min(cols - 1, Math.floor((clamped / 100) * cols));
}

/**
 * confidence(0〜1) → 行 index。高 confidence を上段（row=0）に置く（縦軸＝確信度・上ほど高い）。
 * 範囲外はクランプ。
 */
export function confidenceToRow(confidence: number, rows: number = DEFAULT_DIMS.rows): number {
  const clamped = Math.min(1, Math.max(0, confidence));
  const fromBottom = Math.min(rows - 1, Math.floor(clamped * rows));
  return rows - 1 - fromBottom;
}

/**
 * 点をセル座標へ写す。score か confidence が未採点（null）なら配置できない＝null を返す
 * （詳細画面では「未配置」として別途案内する）。
 */
export function plotPoint(point: MatrixPoint, dims: MatrixDims = DEFAULT_DIMS): MatrixCell | null {
  if (point.score === null || point.confidence === null) return null;
  return { col: scoreToColumn(point.score, dims.cols), row: confidenceToRow(point.confidence, dims.rows) };
}

const CELL_STYLE = {
  border: "1px solid #eaecf0",
  minHeight: 44,
  padding: 4,
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  alignContent: "flex-start",
} as const;
const AXIS_LABEL_STYLE = { fontSize: 12, color: "#667085" } as const;

export type ScoreConfidenceMatrixProps = {
  points: MatrixPoint[];
  dims?: MatrixDims;
};

/**
 * 2軸ビュー（表示専用）。横=score・縦=confidence の格子に points をプロットする。
 * 未配置（score/confidence 未採点）の点は格子下に件数とラベルを併記する。
 */
export function ScoreConfidenceMatrix({ points, dims = DEFAULT_DIMS }: ScoreConfidenceMatrixProps) {
  // セル → そのセルに入る点。row-major で空セルも保持する。
  const grid: MatrixPoint[][] = Array.from({ length: dims.rows * dims.cols }, () => []);
  const unplotted: MatrixPoint[] = [];
  for (const p of points) {
    const cell = plotPoint(p, dims);
    if (cell === null) {
      unplotted.push(p);
      continue;
    }
    grid[cell.row * dims.cols + cell.col]?.push(p);
  }

  return (
    <section aria-label="score×confidence 2軸ビュー">
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>score × confidence マップ</h2>
      <div style={{ display: "flex", gap: 8 }}>
        {/* 縦軸ラベル（上＝確信度高）。 */}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <span style={AXIS_LABEL_STYLE}>確信度 高</span>
          <span style={AXIS_LABEL_STYLE}>確信度 低</span>
        </div>
        <div style={{ flex: 1 }}>
          <div
            role="grid"
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${dims.cols}, 1fr)`,
              gridTemplateRows: `repeat(${dims.rows}, 1fr)`,
            }}
          >
            {grid.map((cellPoints, idx) => (
              <div key={idx} role="gridcell" style={CELL_STYLE}>
                {cellPoints.map((p) => (
                  <Badge key={p.id} tone={p.tone ?? "info"}>
                    {p.label}
                  </Badge>
                ))}
              </div>
            ))}
          </div>
          {/* 横軸ラベル（右＝スコア高）。 */}
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            <span style={AXIS_LABEL_STYLE}>スコア 低</span>
            <span style={AXIS_LABEL_STYLE}>スコア 高</span>
          </div>
        </div>
      </div>
      {unplotted.length > 0 ? (
        <p style={{ fontSize: 12, color: "#667085", marginTop: 8 }}>
          未配置（スコア/確信度が未採点）: {unplotted.map((p) => p.label).join("、")}
        </p>
      ) : null}
    </section>
  );
}

/** 詳細取得に使う候補の最小形（GET /api/candidates/[id] の data の一部）。 */
type CandidatePointData = {
  id: string;
  displayId: string;
  stage: string;
  initialScore: number | null;
  detailedScore: number | null;
  confidence: number | null;
};

/**
 * 候補1件を MatrixPoint に写す。score は詳細スコアを優先し、無ければ初期スコアを使う
 * （Top30 ビューでは detailedScore、それ以前は initialScore が一次。§8.4）。
 */
export function candidateToPoint(c: CandidatePointData): MatrixPoint {
  return {
    id: c.id,
    label: c.displayId,
    score: c.detailedScore ?? c.initialScore,
    confidence: c.confidence,
    tone: stageTone(c.stage),
  };
}

/** 候補1件を取得して MatrixPoint へ写す（GET /api/candidates/[id]）。!ok は throw。 */
export async function fetchCandidatePoint(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<MatrixPoint> {
  const res = await fetcher(candidateEndpoint(id), { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`候補の取得に失敗しました（${res.status}）`);
  }
  const body = (await res.json()) as { data?: CandidatePointData };
  if (!body.data) {
    throw new Error("候補の応答が不正です");
  }
  return candidateToPoint(body.data);
}

export type CandidateScoreMatrixProps = {
  candidateId: string;
  /** 親が +1 する再取得シグナル（採点・merge/split 後にプロットを取り直す）。 */
  reloadSignal?: number;
};

/**
 * 詳細画面用コンテナ。当該候補1件を取得して 2軸ビューにプロットする。
 * 一覧での再利用は presentational な ScoreConfidenceMatrix に points を渡す側で行う。
 */
export function CandidateScoreMatrix({ candidateId, reloadSignal }: CandidateScoreMatrixProps) {
  const [point, setPoint] = useState<MatrixPoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const guardRef = useRef(createLatestGuard());

  const load = useCallback(async () => {
    if (!candidateId) return;
    const token = guardRef.current.next();
    setError(null);
    try {
      const p = await fetchCandidatePoint(candidateId);
      if (!guardRef.current.isCurrent(token)) return;
      setPoint(p);
    } catch (e) {
      if (!guardRef.current.isCurrent(token)) return;
      setError(e instanceof Error ? e.message : "候補の取得に失敗しました");
      setPoint(null);
    }
  }, [candidateId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load, reloadSignal]);

  return (
    <>
      {error ? (
        <p role="alert" style={{ color: "#b42318", fontSize: 13 }}>
          {error}
        </p>
      ) : null}
      {point ? (
        <>
          <ScoreConfidenceMatrix points={[point]} />
          <p style={{ fontSize: 12, color: "#667085", marginTop: 8 }}>
            この候補: スコア {formatScore(point.score)} / 確信度{" "}
            <Badge tone={confidenceTone(point.confidence)}>{formatConfidence(point.confidence)}</Badge>
          </p>
        </>
      ) : (
        <ScoreConfidenceMatrix points={[]} />
      )}
    </>
  );
}
