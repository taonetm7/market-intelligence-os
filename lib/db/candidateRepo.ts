// Candidate repository — task-09, spec v2 §7.3 / §8.9 / §15.1。
//
// Candidate の CRUD・stage 変更・棄却（理由コード必須）・スコア素点とキャッシュ
// スコアの保存をこの層に集約する。UI / API route（task-13）は Prisma を直接
// 触らず、必ずこの repository を経由する。
//
// 設計方針:
// - enum（stage / spendType / origin / rejectedReasonCode）は task-02 の Zod
//   スキーマで検証する（文字列直書き禁止）。入力は repository の入口で必ず parse。
// - 配列/オブジェクト（productFormFit / initialInputs / detailedInputs）は
//   task-02 の JSON ヘルパで `*Json` カラムと往復する（SQLite に配列型が無い）。
// - displayId（CND-NNN）は task-07 の採番関数を、挿入と同一トランザクション内で
//   呼ぶ（連番の競合を局所化する）。
// - スコアの「入力素点」と「派生スコア（キャッシュ）」を分離して保存する（§7.3 設計
//   意図: 再計算・重み変更・監査を可能にする）。派生スコアは create では触らず、
//   saveScores 経由でのみ更新する（§8.9 手動/自動の境界: 合計・ゲートは自動、素点は人間）。
//
// 退役の扱い: Candidate は hard delete しない（reject / stage=archived へソフトに退役）。
//   Evidence / ScoreSnapshot / DecisionLog の履歴を破壊しないため、task doc の関数契約
//   （create/getById/update/list/reject/setStage/saveScores）に delete は含めない。
//
// テスト容易性: 各関数は最後の引数で Prisma クライアントを差し替えられる（既定は
//   シングルトン）。テストは専用の SQLite ファイルへ向けた Client を注入する。
//
// Out of scope: スコア計算本体（task-04〜06 を API task-13 が結線）/ ScoreSnapshot
//   自動記録（Slice 2 task-27）/ API route（task-13）。

import { type Candidate, Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";

import {
  decisionTypeSchema,
  originSchema,
  rejectedReasonCodeSchema,
  stageSchema,
  type Stage,
} from "../validation/enums";
import {
  candidateInputSchema,
  confidence01,
  initialInputsSchema,
  parseJsonField,
  score0to5,
  serializeJsonField,
  type InitialInputs,
} from "../validation/schemas";
import { prisma } from "./client";
import { decisionLogRepo } from "./decisionLogRepo";
import { nextCandidateDisplayId } from "./displayId";
import { record as recordSnapshot, SAVE_SCORES_SNAPSHOT_REASON } from "./snapshotRepo";

/**
 * repository が受け取る Prisma クライアント。
 * トランザクションを張る create があるため、TransactionClient ではなく
 * フル機能の PrismaClient を要求する。
 */
export type CandidateDb = PrismaClient;

/**
 * 読み出し時のドメイン表現。`*Json` カラムを復元した配列/オブジェクトを持つ
 * （呼び出し側は JSON 文字列を意識しなくてよい）。
 */
export type CandidateRecord = Candidate & {
  productFormFit: string[];
  /** InitialScore の素点。未設定なら null。 */
  initialInputs: InitialInputs | null;
  /** 詳細スコア12軸の素点。未設定なら null。 */
  detailedInputs: Record<string, number> | null;
};

/** 一覧の各行。紐付け証拠数と一次ソース種別の異なり数を付与する（§9.4 のカラム）。 */
export type CandidateListItem = CandidateRecord & {
  /** 紐付く Evidence の件数。 */
  evidenceCount: number;
  /**
   * Evidence の一次ソース（RawSignal.sourceType）の異なり数（§9.4 distinctSources）。
   * 多面性の指標（同一ソース種別の多重計上で過大評価しないよう「種別の数」を数える）。
   * 証拠 0 件なら 0。evidenceRepo.signalStatsByCandidate.distinctSourceTypes と同義。
   */
  distinctSources: number;
};

/**
 * list の既定外ソート軸。既定（未指定）はスコア単独にしない（§9.4 過信防止）ため、
 * 採番に依らない安定順として createdAt 降順を用いる。スコア順は sortBy で明示選択させる。
 */
export const CANDIDATE_SORT_BY_VALUES = [
  "createdAt",
  "updatedAt",
  "confidence",
  "initialScore",
  "detailedScore",
  "evidenceCount",
] as const;
export const candidateSortBySchema = z.enum(CANDIDATE_SORT_BY_VALUES);
export type CandidateSortBy = z.infer<typeof candidateSortBySchema>;

/** list のフィルタ/ソート条件（すべて任意）。 */
export interface CandidateListFilter {
  stage?: string;
  /** 明示ソート軸。未指定は createdAt 降順（スコア単独にしない）。 */
  sortBy?: CandidateSortBy;
  /** Evidence 件数の下限（この件数以上だけを返す）。 */
  minEvidence?: number;
}

/**
 * setStage / update から直接セットしてよい stage。`rejected` を除外する。
 *
 * 不変条件（§15.1）: `rejected` への遷移は理由コード（rejectedReasonCode）必須＝
 * `reject()` 経由のみとする。`setStage` / `update` から理由コード無しに
 * `stage='rejected'` へ落とせると、棄却理由の傾向分析（§15.1）が成立しなくなる。
 * そこで両パスの stage 入力をこのスキーマに限定し、型レベル（union から `rejected`
 * を除外）と実行時（Zod parse で弾く）の両方で迂回を塞ぐ。
 */
export const settableStageSchema = stageSchema.exclude(["rejected"]);
export type SettableStage = z.infer<typeof settableStageSchema>;

/**
 * 作成入力。共有の `candidateInputSchema` をベースに、`stage` だけ
 * `settableStageSchema`（`rejected` 除外）へ差し替える。
 *
 * 不変条件（§15.1）: `rejected` への到達は理由コード必須＝`reject()` 経由のみ。
 * `candidateInputSchema.stage` は `default("normalized")` だが `rejected` も許容するため、
 * これをそのまま create に流すと理由コード無しで `stage='rejected'` の候補を新規作成でき、
 * setStage / update と同じ迂回路が create に残ってしまう。そこで create の入口でも
 * stage を settable に限定し、型レベル（`rejected` を union から除外）と実行時（Zod が弾く）の
 * 両面で迂回を塞ぐ。`default("normalized")` は維持する（既定ステージは従来どおり）。
 */
export const candidateCreateSchema = candidateInputSchema.extend({
  stage: settableStageSchema.default("normalized"),
});
export type CandidateCreate = z.infer<typeof candidateCreateSchema>;

/**
 * 更新パッチ。入力スキーマの部分集合（省略フィールドは変更しない）。
 *
 * 注意（task-08 の教訓）: `candidateInputSchema.partial()` だけでは不十分。Zod4 は
 * `.partial()` をかけても default を持つフィールド（productFormFit / stage / origin）の
 * default を、キー省略時に materialize してしまう（例: `parse({ title: "x" })`
 * → `productFormFit: []`, `stage: "normalized"`, `origin: "manual"` が混入）。これを
 * そのまま update に流すと「省略したフィールドが default で上書き」される。
 * そこで default を持つ 3 フィールドだけ default 無しの optional に差し替え、
 * 「省略＝undefined＝変更しない」を構造的に保証する。
 *
 * さらに stage は `settableStageSchema`（`rejected` 除外）に差し替え、update から
 * 理由コード無しで `rejected` へ遷移する迂回を型・実行時の両面で禁止する（§15.1）。
 */
export const candidateUpdateSchema = candidateInputSchema.partial().extend({
  productFormFit: z.array(z.string()).optional(),
  stage: settableStageSchema.optional(),
  origin: originSchema.optional(),
});
export type CandidateUpdate = z.infer<typeof candidateUpdateSchema>;

/**
 * 棄却の入力。`rejectedReasonCode`(enum) を必須にする（§15.1 傾向分析用）。
 * コード無しの棄却を構造的に禁止する（自由文 `rejectedReason` は任意の補足）。
 */
export const candidateRejectSchema = z.object({
  id: z.string().min(1),
  rejectedReasonCode: rejectedReasonCodeSchema,
  rejectedReason: z.string().optional(),
});
export type CandidateReject = z.infer<typeof candidateRejectSchema>;

/**
 * スコア保存の入力。入力素点（initialInputs / detailedInputs）と派生スコア
 * （キャッシュ）＋ scoreConfigVersion を併せて受ける（§7.3 / §8.5 / §8.6）。
 * すべて任意で、与えられたものだけ更新する（部分保存）。
 */
export const candidateScoresSchema = z.object({
  initialInputs: initialInputsSchema.optional(),
  detailedInputs: z.record(z.string(), score0to5).optional(),
  initialScore: z.number().optional(),
  detailedScore: z.number().optional(),
  signalBonus: z.number().optional(),
  uncertaintyPenalty: z.number().optional(),
  confidence: confidence01.optional(),
  scoreConfigVersion: z.string().optional(),
});
export type CandidateScores = z.infer<typeof candidateScoresSchema>;

/** Prisma 行をドメイン表現へ復元する（`*Json` → 配列/オブジェクト）。 */
function decode(row: Candidate): CandidateRecord {
  return {
    ...row,
    productFormFit: parseJsonField<string[]>(row.productFormFitJson, []),
    initialInputs: parseJsonField<InitialInputs | null>(row.initialInputsJson, null),
    detailedInputs: parseJsonField<Record<string, number> | null>(row.detailedInputsJson, null),
  };
}

/**
 * Candidate を 1 件作成する。
 * 入力を Zod 検証し、displayId 採番と挿入を同一トランザクションで束ねる。
 * 派生スコア（initialScore 等）と scoreConfigVersion はここでは設定しない（saveScores 専用）。
 * `stage='rejected'` は受け付けない（§15.1: rejected への到達は `reject()` 経由のみ）。
 */
export async function create(
  input: CandidateCreate,
  db: CandidateDb = prisma,
): Promise<CandidateRecord> {
  const data = candidateCreateSchema.parse(input);
  const row = await db.$transaction(async (tx) => {
    const displayId = await nextCandidateDisplayId(tx);
    return tx.candidate.create({
      data: {
        displayId,
        problemFamily: data.problemFamily,
        title: data.title,
        targetUser: data.targetUser,
        contextTrigger: data.contextTrigger,
        painStatement: data.painStatement,
        currentSubstitute: data.currentSubstitute,
        spendType: data.spendType,
        monetizationGuess: data.monetizationGuess,
        productFormFitJson: serializeJsonField(data.productFormFit),
        initialInputsJson: serializeJsonField(data.initialInputs),
        detailedInputsJson: serializeJsonField(data.detailedInputs),
        founderFit: data.founderFit,
        buildEase: data.buildEase,
        legalRisk: data.legalRisk,
        opsRisk: data.opsRisk,
        confidence: data.confidence,
        stage: data.stage,
        testableWithinDays: data.testableWithinDays,
        testMethod: data.testMethod,
        nextAction: data.nextAction,
        rejectedReason: data.rejectedReason,
        rejectedReasonCode: data.rejectedReasonCode,
        origin: data.origin,
      },
    });
  });
  return decode(row);
}

/** id で 1 件取得する。存在しなければ null。 */
export async function getById(
  id: string,
  db: CandidateDb = prisma,
): Promise<CandidateRecord | null> {
  const row = await db.candidate.findUnique({ where: { id } });
  return row ? decode(row) : null;
}

/**
 * 部分更新する。省略フィールドは変更しない（displayId / id は不変）。
 * productFormFit / initialInputs / detailedInputs が与えられた場合のみ `*Json` を再直列化する。
 * 派生スコアはこのパスでは変更できない（saveScores 専用）。
 */
export async function update(
  id: string,
  patch: CandidateUpdate,
  db: CandidateDb = prisma,
): Promise<CandidateRecord> {
  const data = candidateUpdateSchema.parse(patch);
  const updateData: Prisma.CandidateUpdateInput = {};
  if (data.problemFamily !== undefined) updateData.problemFamily = data.problemFamily;
  if (data.title !== undefined) updateData.title = data.title;
  if (data.targetUser !== undefined) updateData.targetUser = data.targetUser;
  if (data.contextTrigger !== undefined) updateData.contextTrigger = data.contextTrigger;
  if (data.painStatement !== undefined) updateData.painStatement = data.painStatement;
  if (data.currentSubstitute !== undefined) updateData.currentSubstitute = data.currentSubstitute;
  if (data.spendType !== undefined) updateData.spendType = data.spendType;
  if (data.monetizationGuess !== undefined) updateData.monetizationGuess = data.monetizationGuess;
  if (data.productFormFit !== undefined) {
    updateData.productFormFitJson = serializeJsonField(data.productFormFit);
  }
  if (data.initialInputs !== undefined) {
    updateData.initialInputsJson = serializeJsonField(data.initialInputs);
  }
  if (data.detailedInputs !== undefined) {
    updateData.detailedInputsJson = serializeJsonField(data.detailedInputs);
  }
  if (data.founderFit !== undefined) updateData.founderFit = data.founderFit;
  if (data.buildEase !== undefined) updateData.buildEase = data.buildEase;
  if (data.legalRisk !== undefined) updateData.legalRisk = data.legalRisk;
  if (data.opsRisk !== undefined) updateData.opsRisk = data.opsRisk;
  if (data.confidence !== undefined) updateData.confidence = data.confidence;
  if (data.stage !== undefined) updateData.stage = data.stage;
  if (data.testableWithinDays !== undefined) updateData.testableWithinDays = data.testableWithinDays;
  if (data.testMethod !== undefined) updateData.testMethod = data.testMethod;
  if (data.nextAction !== undefined) updateData.nextAction = data.nextAction;
  if (data.rejectedReason !== undefined) updateData.rejectedReason = data.rejectedReason;
  if (data.rejectedReasonCode !== undefined) updateData.rejectedReasonCode = data.rejectedReasonCode;
  if (data.origin !== undefined) updateData.origin = data.origin;

  const row = await db.candidate.update({ where: { id }, data: updateData });
  return decode(row);
}

/**
 * stage を変更する（§14 のステージ管理）。enum を Zod 検証してから更新する。
 * 進級ゲートの判定自体は呼び出し側（API task-13）の責務。ここは永続化のみ。
 *
 * `rejected` への遷移はここでは行えない（§15.1）。理由コード必須のため、棄却は
 * `reject()` 経由に限定する。`settableStageSchema` が `rejected` を弾く（実行時）と
 * ともに、`SettableStage` 型で型レベルにも `rejected` を渡せないようにする。
 */
export async function setStage(
  id: string,
  stage: SettableStage,
  db: CandidateDb = prisma,
): Promise<CandidateRecord> {
  const validated = settableStageSchema.parse(stage);
  const row = await db.candidate.update({ where: { id }, data: { stage: validated } });
  return decode(row);
}

/**
 * 昇格の入力。`toStage`（settable）と DecisionLog に刻む昇格イベント（fromStage / reason）を
 * 受ける。decisionType は `promote` 固定（この関数の意味論そのもの）なので呼び出し側は渡さない。
 */
export interface CandidatePromote {
  /** 昇格先 stage（`rejected` 不可）。 */
  toStage: SettableStage;
  /** 昇格元 stage（DecisionLog の fromStage に残す）。 */
  fromStage: Stage;
  /** 昇格理由（DecisionLog の必須 reason・§15.3）。空文字は log 側の Zod が弾く。 */
  reason: string;
}

/**
 * stage を1段昇格し、その判断（DecisionLog: promote）を**同一トランザクションで原子的に**刻む
 * （§8.9 / §15.3）。ゲート判定そのものは呼び出し側（API task-30）の責務で、ここは「昇格の
 * 永続化＋判断履歴の記録」を一体で扱う。
 *
 * 不可分にする理由（task-30 受け入れ条件）: stage 更新と DecisionLog を別 DB 操作に分けると、
 * log 失敗時に「stage だけ昇格し判断履歴が欠ける」状態が永続化され得て監査が破綻する。
 * `decisionLogRepo.log` は単発 create で内部に $transaction を張らない（TransactionClient 対応）
 * ため、ここでネストせずに同一 `$transaction` 内へ入れられる（saveScores + snapshot と同じ流儀）。
 *
 * `rejected` への遷移はここでは行えない（§15.1: 棄却は理由コード必須＝`reject()` 経由のみ）。
 */
export async function promote(
  id: string,
  input: CandidatePromote,
  db: CandidateDb = prisma,
): Promise<CandidateRecord> {
  const toStage = settableStageSchema.parse(input.toStage);
  const row = await db.$transaction(async (tx) => {
    const updated = await tx.candidate.update({ where: { id }, data: { stage: toStage } });
    await decisionLogRepo.log(
      {
        candidateId: id,
        decisionType: decisionTypeSchema.enum.promote,
        fromStage: input.fromStage,
        toStage,
        reason: input.reason,
      },
      tx,
    );
    return updated;
  });
  return decode(row);
}

/**
 * 棄却する。`rejectedReasonCode`(enum) 必須・`stage='rejected'` に固定する（§15.1）。
 * コード無し（未指定や不正値）は Zod が弾く＝棄却できない。
 */
export async function reject(
  input: CandidateReject,
  db: CandidateDb = prisma,
): Promise<CandidateRecord> {
  const data = candidateRejectSchema.parse(input);
  const row = await db.candidate.update({
    where: { id: data.id },
    data: {
      stage: "rejected",
      rejectedReasonCode: data.rejectedReasonCode,
      rejectedReason: data.rejectedReason,
    },
  });
  return decode(row);
}

/**
 * スコアを保存する。入力素点（initialInputs / detailedInputs）と派生スコア
 * （initialScore / detailedScore / signalBonus / uncertaintyPenalty / confidence）と
 * scoreConfigVersion を、与えられたものだけ更新する（§7.3 設計意図: 素点も保存して
 * 再計算/重み変更/監査を可能にする）。スコア計算本体はここには持たない（§8.9）。
 *
 * 保存のたびに ScoreSnapshot を 1 行**自動記録**する（task-28・§7.5）。週次の上昇/低下
 * 候補（§9.9）が機能する前提として、スコア更新と snapshot を同一 `$transaction` で原子的に
 * 刻む。snapshot は「更新後の Candidate の派生スコア一式」を写すため、部分保存でも常にその
 * 時点の完全なスコア状態が履歴に残る（差分が常に追える）。
 */
export async function saveScores(
  id: string,
  scores: CandidateScores,
  db: CandidateDb = prisma,
): Promise<CandidateRecord> {
  const data = candidateScoresSchema.parse(scores);
  const updateData: Prisma.CandidateUpdateInput = {};
  if (data.initialInputs !== undefined) {
    updateData.initialInputsJson = serializeJsonField(data.initialInputs);
  }
  if (data.detailedInputs !== undefined) {
    updateData.detailedInputsJson = serializeJsonField(data.detailedInputs);
  }
  if (data.initialScore !== undefined) updateData.initialScore = data.initialScore;
  if (data.detailedScore !== undefined) updateData.detailedScore = data.detailedScore;
  if (data.signalBonus !== undefined) updateData.signalBonus = data.signalBonus;
  if (data.uncertaintyPenalty !== undefined) updateData.uncertaintyPenalty = data.uncertaintyPenalty;
  if (data.confidence !== undefined) updateData.confidence = data.confidence;
  if (data.scoreConfigVersion !== undefined) updateData.scoreConfigVersion = data.scoreConfigVersion;

  // スコア更新と snapshot 記録を原子的に行う（片方だけ成功して履歴が欠ける状態を防ぐ）。
  // recordSnapshot は単発 create で内部に $transaction を張らないため、ここでネストできる。
  const row = await db.$transaction(async (tx) => {
    const updated = await tx.candidate.update({ where: { id }, data: updateData });
    await recordSnapshot(
      {
        candidateId: updated.id,
        initialScore: updated.initialScore,
        detailedScore: updated.detailedScore,
        signalBonus: updated.signalBonus,
        uncertaintyPenalty: updated.uncertaintyPenalty,
        confidence: updated.confidence,
        configVersion: updated.scoreConfigVersion,
        reason: SAVE_SCORES_SNAPSHOT_REASON,
      },
      tx,
    );
    return updated;
  });
  return decode(row);
}

/**
 * 明示ソート軸 → Prisma orderBy（安定化のため displayId 降順を常に第2キーにする）。
 * 既定（未指定）は createdAt 降順。スコア（initialScore 等）を既定にしない（§9.4 過信防止）。
 */
function orderByFor(sortBy?: CandidateSortBy): Prisma.CandidateOrderByWithRelationInput[] {
  const tieBreak: Prisma.CandidateOrderByWithRelationInput = { displayId: "desc" };
  switch (sortBy) {
    case "updatedAt":
      return [{ updatedAt: "desc" }, tieBreak];
    case "confidence":
      return [{ confidence: "desc" }, tieBreak];
    case "initialScore":
      return [{ initialScore: "desc" }, tieBreak];
    case "detailedScore":
      return [{ detailedScore: "desc" }, tieBreak];
    case "evidenceCount":
      return [{ evidences: { _count: "desc" } }, tieBreak];
    case "createdAt":
    default:
      return [{ createdAt: "desc" }, tieBreak];
  }
}

/**
 * 一覧を返す。stage は Zod 検証してから where に積む。
 * sortBy で明示ソート（既定はスコア単独でなく createdAt 降順）。
 * minEvidence は Evidence 件数の下限フィルタ（Prisma の where では _count を直接
 * 比較できないため、件数を付与した上でアプリ層で絞る。単一ローカルユーザー前提で
 * 件数が小さいことを利用する）。各行に証拠数（evidenceCount）と一次ソース種別の
 * 異なり数（distinctSources・§9.4）を付与する。
 */
export async function list(
  filter: CandidateListFilter = {},
  db: CandidateDb = prisma,
): Promise<CandidateListItem[]> {
  const where: Prisma.CandidateWhereInput = {};
  if (filter.stage !== undefined) {
    where.stage = stageSchema.parse(filter.stage);
  }
  const sortBy = filter.sortBy === undefined ? undefined : candidateSortBySchema.parse(filter.sortBy);

  const rows = await db.candidate.findMany({
    where,
    orderBy: orderByFor(sortBy),
    include: {
      _count: { select: { evidences: true } },
      // distinctSources（§9.4）= Evidence の一次ソース種別の異なり数。RawSignal.sourceType
      // だけを nested select で薄く読み（他カラムは引かない）、下で Set により重複排除して
      // 数える。ネストした include は Prisma が候補数によらず一定本数のクエリへバッチ化する
      // ため、候補ごとに問い合わせる N+1 にはならない（_count と同じ findMany 1 回に同梱）。
      evidences: { select: { rawSignal: { select: { sourceType: true } } } },
    },
  });
  const items = rows.map(({ _count, evidences, ...row }) => ({
    ...decode(row),
    evidenceCount: _count.evidences,
    distinctSources: new Set(evidences.map((e) => e.rawSignal.sourceType)).size,
  }));
  if (filter.minEvidence !== undefined) {
    const min = filter.minEvidence;
    return items.filter((item) => item.evidenceCount >= min);
  }
  return items;
}

/** Candidate 操作の集約 repository。 */
export const candidateRepo = {
  create,
  getById,
  update,
  setStage,
  promote,
  reject,
  saveScores,
  list,
};
