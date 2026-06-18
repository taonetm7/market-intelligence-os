// Candidate merge / split 意味論 — task-29, spec v2 §15.2。
//
// 重複候補の統合（merge）と、1 候補からの分割（split）を、履歴を壊さずに行う。
// 判断の妥当性を後から見直せるよう、両操作とも DecisionLog を残す（§15.2 / §15.3）。
//
// merge:
//   吸収側 Candidate の Evidence / ScoreSnapshot / DecisionLog を生存側へ **re-parent**
//   し、吸収側を `stage=archived` にする。両者に DecisionLog(merge, relatedCandidateId)
//   を刻む。ただし re-parent する DecisionLog からは decisionType=merge のログを除外する
//   ——merge ログは「その候補で統合イベントが起きた」固有の履歴なので吸収側に残す。これ
//   が無いと連鎖統合（C→B 後に B→A）で B の merge ログが A へ移り誤配置される。Evidence
//   は `@@unique([candidateId, rawSignalId, evidenceType])` を持つため、生存側に同一キー
//   の証拠が既にある場合は移送せず吸収側の重複を破棄する（片方を残す）。
//
// split:
//   元候補の複製を 1 件生成し、指定した Evidence だけを新候補へ移す。元候補に
//   DecisionLog(split, relatedCandidateId=新ID) を刻む。新候補は空なので Evidence の
//   unique 衝突は起きない。
//
// 設計方針:
// - 全操作を 1 つの `$transaction` で束ね、途中失敗で再親付けが半端に残る状態を防ぐ。
// - Prisma はネスト interactive transaction 不可。よって複製候補の生成は
//   candidateRepo.create（内部で $transaction を張る）を呼ばず、tx 内で
//   nextCandidateDisplayId(tx) ＋ tx.candidate.create を直接使って採番→挿入する
//   （rawSignalRepo.create / candidateRepo.saveScores の内部 transaction と衝突させない）。
// - DecisionLog の記録は decisionLogRepo.log を tx 付きで呼ぶ（enum / reason 検証を共有）。
//   既存ログの re-parent を先に済ませてから新しい merge ログを刻むので、吸収側の merge
//   ログは吸収側に残る（先に移送→後から記録の順序が重要）。
//
// 冪等性: 生存側＝吸収側、reason 空、存在しない候補は弾く。さらに吸収側が既に archived
//   （＝統合済み）の場合は明示エラーで弾き、同一 merge の再実行で両者へ merge ログが
//   二重に刻まれる（履歴の重複）のを防ぐ（task doc「全操作トランザクション・冪等性に注意」）。
//
// Out of scope: 重複サジェスト（task-34）/ UI（task-31）/ auto-snapshot（§18.4）。

import { type PrismaClient } from "@prisma/client";

import { decisionTypeSchema, stageSchema, type Stage } from "../validation/enums";
import { prisma } from "./client";
import { log } from "./decisionLogRepo";
import { nextCandidateDisplayId } from "./displayId";

/**
 * merge / split が受け取る Prisma クライアント。
 * 全操作を束ねる $transaction を張るため、フル機能の PrismaClient を要求する。
 */
export type CandidateMergeDb = PrismaClient;

/** merge の引数。生存側・吸収側・理由（必須）。 */
export interface MergeArgs {
  /** 残す側の Candidate。子レコードはここへ集約される。 */
  survivorId: string;
  /** 吸収される側の Candidate。archived になり、子レコードを生存側へ譲る。 */
  absorbedId: string;
  /** 判断理由（§15.3 必須）。両者の merge ログに刻む。 */
  reason: string;
}

/** merge の結果サマリ。 */
export interface MergeResult {
  survivorId: string;
  absorbedId: string;
  /** 生存側へ移送した Evidence 件数。 */
  reparentedEvidence: number;
  /** unique 衝突で破棄した吸収側 Evidence 件数。 */
  droppedEvidence: number;
  /** 生存側へ移送した ScoreSnapshot 件数。 */
  reparentedSnapshots: number;
  /** 生存側へ移送した（既存の）DecisionLog 件数。新しい merge ログ 2 件は含まない。 */
  reparentedLogs: number;
}

/** split の引数。元候補・新候補へ移す Evidence・理由（必須）・任意のタイトル上書き。 */
export interface SplitArgs {
  /** 分割元の Candidate。 */
  sourceId: string;
  /** 新候補へ移す Evidence の id 群（元候補に属するものだけが対象）。 */
  evidenceIds: string[];
  /** 判断理由（§15.3 必須）。元候補の split ログに刻む。 */
  reason: string;
  /** 新候補のタイトル上書き（省略時は元候補のタイトルを継承）。 */
  title?: string;
}

/** split の結果サマリ。 */
export interface SplitResult {
  sourceId: string;
  /** 生成された新候補の id。 */
  newCandidateId: string;
  /** 新候補へ移した Evidence 件数。 */
  movedEvidence: number;
}

/** Evidence の unique キー（candidateId は移送先で共通になるため rawSignalId×evidenceType で判定）。 */
function evidenceKey(rawSignalId: string, evidenceType: string): string {
  // 区切り「::」で連結する（cuid と enum 値に :: は現れないため衝突しない）。
  return `${rawSignalId}::${evidenceType}`;
}

/**
 * 2 つの Candidate を統合する（§15.2）。
 * 吸収側の Evidence / ScoreSnapshot / DecisionLog を生存側へ re-parent し、吸収側を
 * archived にして、両者に merge ログを刻む。Evidence の unique 衝突は生存側を残して
 * 吸収側の重複を破棄する。全操作を 1 トランザクションで原子的に行う。
 */
export async function merge(args: MergeArgs, db: CandidateMergeDb = prisma): Promise<MergeResult> {
  const { survivorId, absorbedId, reason } = args;
  if (reason.trim() === "") {
    throw new Error("merge には判断理由（reason）が必須です（§15.3）");
  }
  if (survivorId === absorbedId) {
    throw new Error("merge の生存側と吸収側が同一です");
  }

  return db.$transaction(async (tx) => {
    const survivor = await tx.candidate.findUnique({ where: { id: survivorId } });
    const absorbed = await tx.candidate.findUnique({ where: { id: absorbedId } });
    if (survivor === null) {
      throw new Error(`merge 生存側の Candidate が存在しません: ${survivorId}`);
    }
    if (absorbed === null) {
      throw new Error(`merge 吸収側の Candidate が存在しません: ${absorbedId}`);
    }

    // 冪等性ガード（§15.2 / task doc「全操作トランザクション・冪等性に注意」）。吸収側が
    // 既に archived の場合、その候補は統合済み（中身は他所へ移送済み）。ここで再び merge を
    // 走らせると、移送対象が無いまま両者へ DecisionLog(merge) が二重に刻まれ履歴が重複する。
    // reason 空・同一 id・候補不在と同じく不正な前提条件として明示エラーで弾く（no-op で
    // 0 件成功を返すと、誤った survivor を渡した呼び出しバグを隠蔽しうるため throw を選ぶ）。
    // enum 値は task-02 の Zod スキーマ経由で参照し直書きを避ける。
    if (absorbed.stage === stageSchema.enum.archived) {
      throw new Error(`merge 吸収側は既に archived です（統合済み）。再 merge できません: ${absorbedId}`);
    }

    // Evidence を再親付け。生存側に同一キー（rawSignalId×evidenceType）が既にある場合は
    // @@unique に違反するため、移送せず吸収側の重複を破棄する（片方を残す）。
    const survivorEvidence = await tx.evidence.findMany({
      where: { candidateId: survivorId },
      select: { rawSignalId: true, evidenceType: true },
    });
    const keys = new Set(survivorEvidence.map((e) => evidenceKey(e.rawSignalId, e.evidenceType)));
    const absorbedEvidence = await tx.evidence.findMany({ where: { candidateId: absorbedId } });
    let reparentedEvidence = 0;
    let droppedEvidence = 0;
    for (const ev of absorbedEvidence) {
      const key = evidenceKey(ev.rawSignalId, ev.evidenceType);
      if (keys.has(key)) {
        await tx.evidence.delete({ where: { id: ev.id } });
        droppedEvidence += 1;
      } else {
        await tx.evidence.update({ where: { id: ev.id }, data: { candidateId: survivorId } });
        keys.add(key);
        reparentedEvidence += 1;
      }
    }

    // ScoreSnapshot は unique 制約が無いため一括で再親付けできる。
    const snapshots = await tx.scoreSnapshot.updateMany({
      where: { candidateId: absorbedId },
      data: { candidateId: survivorId },
    });
    // DecisionLog も再親付けするが、decisionType=merge のログは除外する。merge ログは
    // 「その候補で統合イベントが起きた」固有の履歴（自分が何かを吸収した／自分が吸収され
    // archived になった）であり、生存側へ移すと連鎖統合（C→B 後に B→A）で「A が C を
    // 吸収した」と誤配置される。吸収側の merge ログは吸収側に残す（enum 値は task-02 の
    // スキーマ経由で参照し直書きを避ける）。promote / demote / reject / hold / split など
    // の判断ログは、吸収側の中身が生存側へ集約されるのに合わせて移送する。
    const logs = await tx.decisionLog.updateMany({
      where: { candidateId: absorbedId, decisionType: { not: decisionTypeSchema.enum.merge } },
      data: { candidateId: survivorId },
    });

    // 吸収側を退役（archived）。Candidate は hard delete しない（履歴を残す）。
    await tx.candidate.update({ where: { id: absorbedId }, data: { stage: "archived" } });

    // 両者に merge ログを刻む。既存ログの再親付け後に作るので、吸収側の merge ログは
    // 吸収側に残る（先に移送→後から記録）。吸収側は stage 遷移も記録する。
    await log({ candidateId: survivorId, decisionType: "merge", relatedCandidateId: absorbedId, reason }, tx);
    await log(
      {
        candidateId: absorbedId,
        decisionType: "merge",
        // absorbed.stage は repo 経由で書かれた検証済み値。log の入口で stageSchema が再検証する。
        fromStage: absorbed.stage as Stage,
        toStage: "archived",
        relatedCandidateId: survivorId,
        reason,
      },
      tx,
    );

    return {
      survivorId,
      absorbedId,
      reparentedEvidence,
      droppedEvidence,
      reparentedSnapshots: snapshots.count,
      reparentedLogs: logs.count,
    };
  });
}

/**
 * 1 つの Candidate を分割する（§15.2）。
 * 元候補の複製を 1 件生成し、指定した Evidence を新候補へ移す。元候補に split ログ
 * （relatedCandidateId=新ID）を刻む。新候補は空なので Evidence の unique 衝突は起きない。
 * 全操作を 1 トランザクションで原子的に行う。
 */
export async function split(args: SplitArgs, db: CandidateMergeDb = prisma): Promise<SplitResult> {
  const { sourceId, evidenceIds, reason, title } = args;
  if (reason.trim() === "") {
    throw new Error("split には判断理由（reason）が必須です（§15.3）");
  }

  return db.$transaction(async (tx) => {
    const source = await tx.candidate.findUnique({ where: { id: sourceId } });
    if (source === null) {
      throw new Error(`split 元の Candidate が存在しません: ${sourceId}`);
    }

    // 複製候補を生成。candidateRepo.create はネスト不可（内部で $transaction を張る）ため、
    // tx 内で採番→挿入を直接行う。*Json カラムは直列化済みの文字列をそのまま複製する。
    const displayId = await nextCandidateDisplayId(tx);
    const created = await tx.candidate.create({
      data: {
        displayId,
        problemFamily: source.problemFamily,
        title: title ?? source.title,
        targetUser: source.targetUser,
        contextTrigger: source.contextTrigger,
        painStatement: source.painStatement,
        currentSubstitute: source.currentSubstitute,
        spendType: source.spendType,
        monetizationGuess: source.monetizationGuess,
        productFormFitJson: source.productFormFitJson,
        initialInputsJson: source.initialInputsJson,
        detailedInputsJson: source.detailedInputsJson,
        founderFit: source.founderFit,
        buildEase: source.buildEase,
        legalRisk: source.legalRisk,
        opsRisk: source.opsRisk,
        initialScore: source.initialScore,
        detailedScore: source.detailedScore,
        signalBonus: source.signalBonus,
        uncertaintyPenalty: source.uncertaintyPenalty,
        confidence: source.confidence,
        scoreConfigVersion: source.scoreConfigVersion,
        stage: source.stage,
        testableWithinDays: source.testableWithinDays,
        testMethod: source.testMethod,
        nextAction: source.nextAction,
        rejectedReason: source.rejectedReason,
        rejectedReasonCode: source.rejectedReasonCode,
        // split は元候補の「現在の状態」を忠実に複製する（stage / rejectedReason / rejectedReasonCode を
        // そのまま継承）。棄却済み候補を split した子は同じ棄却状態を引き継ぐので、棄却時刻 rejectedAt も
        // 併せて複製する（改善①）。reason/Code は継承するのに rejectedAt だけ落とすと、子が「理由コードを
        // 持つのに rejectedAt=null」という不整合状態になり、週次レポートの期間絞り（rejectedAt 基準）から
        // 不当に漏れる。3 フィールドを一体で継承して棄却状態の整合を保つ。
        rejectedAt: source.rejectedAt,
        origin: source.origin,
      },
    });

    // 指定 Evidence を新候補へ移す。元候補に属するものだけを対象にし、他候補の Evidence を
    // 誤って奪わないようにする（candidateId=sourceId で絞る）。新候補は空なので衝突しない。
    let movedEvidence = 0;
    if (evidenceIds.length > 0) {
      const moved = await tx.evidence.updateMany({
        where: { id: { in: evidenceIds }, candidateId: sourceId },
        data: { candidateId: created.id },
      });
      movedEvidence = moved.count;
    }

    // 元候補に split ログを刻む（相手＝新候補）。
    await log(
      { candidateId: sourceId, decisionType: "split", relatedCandidateId: created.id, reason },
      tx,
    );

    return { sourceId, newCandidateId: created.id, movedEvidence };
  });
}

/** merge / split の集約。 */
export const candidateMerge = {
  merge,
  split,
};
