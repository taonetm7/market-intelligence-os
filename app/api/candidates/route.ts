// Candidate API routes（一覧 / 作成）— task-13, spec v2 §8 / §13 Slice 1。
//
// repository（lib/db/candidateRepo.ts）を薄く包む App Router の route handler。
// 設計方針（task-11/12 と同じ流儀）:
// - route handler は repository を呼ぶだけ（ビジネスロジック・Prisma 直呼びは持たない）。
// - 入力検証は repository の Zod（candidateCreateSchema / 列挙）に委ねる。route 側は
//   その ZodError を 400 へ、想定外を 500 へ翻訳する（エラー型 → HTTP の翻訳責務）。
// - 返却は常に { data } / { error } の一貫形。ステータスは 200/201/400/500 を使い分ける。
//
// Out of scope: detailed score / top30 / promote の DecisionLog（Slice 2）。stage 昇格操作。

import { z } from "zod";

import {
  candidateRepo,
  type CandidateCreate,
  type CandidateListFilter,
  type CandidateSortBy,
} from "../../../lib/db/candidateRepo";

/** ZodError は 400（詳細 issues 付き）、それ以外は 500 に翻訳する共通応答。 */
function errorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return Response.json(
      { error: { message: "入力が不正です", issues: error.issues } },
      { status: 400 },
    );
  }
  return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
}

/** stage 入力を拒否したときの共通 400 ボディ。 */
const STAGE_FORBIDDEN_BODY = {
  error: {
    message: "stage はこの API では変更できません（昇格は専用 API、棄却は POST /reject、退役は DELETE）",
  },
} as const;

/**
 * body に `stage` キーが含まれるか判定する。
 *
 * stage 昇格（normalized → top100 / top30 / …）はゲート判定を伴う task-21 の責務で、
 * task-13 では Out of scope（§13）。作成/更新 API から任意の stage を渡せると進級ゲートを
 * 迂回して昇格できてしまうため、stage 入力は受け付けない。正規の stage 遷移経路は
 * 「昇格＝専用 API（task-21）」「棄却＝POST /reject（理由コード必須・§15.1）」
 * 「退役＝DELETE（archived ソフト退役）」のみ。黙って無視すると誤用が顕在化しないため、
 * stage を含むリクエストは明示的に 400 で拒否する（共有 Zod スキーマ / repository は不変更）。
 */
function hasStageInput(body: unknown): boolean {
  return typeof body === "object" && body !== null && "stage" in body;
}

/**
 * GET /api/candidates — 一覧。
 * クエリ `?stage=&sortBy=&minEvidence=` を repository.list のフィルタへマップする。
 * 空文字のパラメータは未指定として無視する（不正 enum / sortBy は repository の Zod が 400 に落とす）。
 * 既定（sortBy 未指定）はスコア単独でなく createdAt 降順（§9.4 過信防止）。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const sp = new URL(request.url).searchParams;
    const filter: CandidateListFilter = {};
    const stage = sp.get("stage");
    if (stage) filter.stage = stage;
    const sortBy = sp.get("sortBy");
    // 値の妥当性は repository の candidateSortBySchema.parse が検証する（不正は 400）。
    if (sortBy) filter.sortBy = sortBy as CandidateSortBy;
    const minEvidence = sp.get("minEvidence");
    if (minEvidence) {
      const n = Number(minEvidence);
      if (Number.isFinite(n)) filter.minEvidence = n;
    }

    const data = await candidateRepo.list(filter);
    return Response.json({ data }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/candidates — 作成。
 * リクエストボディを CandidateCreate として repository に渡す（検証は repository の Zod）。
 * 派生スコアは作成時に触らない（saveScores 専用）。stage 入力は受け付けない（昇格は task-21、
 * 棄却は POST /reject、退役は DELETE が正規経路。§13 Out of scope / §15.1）。新規作成は常に
 * 既定 stage（normalized）になる。JSON として不正なボディは 400、stage 指定は 400、
 * 検証 NG は 400（issues 付き）、成功は 201 で { data }。
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { message: "リクエストボディの JSON が不正です" } },
      { status: 400 },
    );
  }
  // stage 昇格の迂回を塞ぐ: 作成時に stage は指定させない（既定 normalized 固定）。
  if (hasStageInput(body)) {
    return Response.json(STAGE_FORBIDDEN_BODY, { status: 400 });
  }
  try {
    const data = await candidateRepo.create(body as CandidateCreate);
    return Response.json({ data }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
