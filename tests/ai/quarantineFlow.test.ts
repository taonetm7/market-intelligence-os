import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { submitAiRawSignalsToQuarantine } from "../../lib/ai/quarantineIntake";
import { tagSuggest } from "../../lib/ai/suggest";
import { buildMissingEvidenceQuarantineDrafts } from "../../components/candidate/CandidateDetail";
import {
  buildQuarantineDraftsFromFields,
  emptyQuickCaptureFields,
} from "../../components/raw-signal/QuickCapture";
import { quarantineRepo } from "../../lib/import/quarantineRepo";
import { originSchema, sourceTypeSchema } from "../../lib/validation/enums";

// task-39 Phase 2 acceptance（spec v2 §11.2 / Codex 指摘①）:
// 「AI 由来データが origin=ai で quarantine 経由になる」実経路をエンドツーエンドで検証する。
//   AI 提案（tagSuggest）→ RawSignal 下書き → quarantine 投入（origin=ai 固定）→
//   **人間 accept** で初めて RawSignal が origin=ai で本登録される（直接 DB へは書かない）。
//
// task-15（quarantineRepo / parse）は無改変で再利用する。専用 SQLite を repo に注入し、
// 各テスト前に全テーブルをリセットして決定論性を担保する（dev.db は触らない）。
// import は相対パス（@/ エイリアスは vitest 非対応）。

let dbDir: string;
let db: PrismaClient;

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-ai-quarantine-"));
  const url = `file:${join(dbDir, "test.db")}`;
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  db = new PrismaClient({ datasources: { db: { url } } });
});

afterAll(async () => {
  await db.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.quarantineRow.deleteMany();
  await db.importBatch.deleteMany();
  await db.evidence.deleteMany();
  await db.rawSignal.deleteMany();
});

/** 指定 JSON を text として返す偽 complete（実ネットワークを叩かない）。 */
function fakeComplete(payload: unknown) {
  return async () => JSON.stringify(payload);
}

describe("AI 提案 → quarantine(origin=ai) → 人間 accept の実経路", () => {
  it("AI タグ提案を反映した RawSignal 下書きは origin=ai で隔離され、accept で初めて本登録される", async () => {
    // 1) AI 提案（タグ候補）を取得（モデルはモック）。
    const proposal = await tagSuggest(
      { text: "個人事業主が請求書作成に困っている" },
      fakeComplete({ tags: ["請求書", "freelancer"] }),
    );
    expect(proposal.origin).toBe(originSchema.enum.ai);

    // 2) 人間が確認した RawSignal 下書きに AI 提案タグを反映して quarantine へ投入する。
    const draft = {
      sourceType: "review",
      rawText: "請求書作成に時間がかかるという不満",
      observedEntity: "請求書アプリ",
      tags: proposal.proposed.tags, // AI 由来のタグ
    };
    const intake = await submitAiRawSignalsToQuarantine([draft], db);

    // batch / payload に origin=ai が焼き込まれ、まだ RawSignal は作られていない（関門）。
    expect(intake.batch.origin).toBe(originSchema.enum.ai);
    expect(intake.pending).toHaveLength(1);
    expect(intake.invalid).toHaveLength(0);
    const payload = JSON.parse(intake.pending[0].payloadJson ?? "{}") as { origin: string };
    expect(payload.origin).toBe(originSchema.enum.ai);
    expect(await db.rawSignal.count()).toBe(0); // accept 前は本登録ゼロ

    // 3) 人間 accept で初めて RawSignal が origin=ai で本登録される。
    const accepted = await quarantineRepo.accept(intake.batch.id, undefined, db);
    expect(accepted.accepted).toHaveLength(1);
    expect(accepted.accepted[0].rawSignal.origin).toBe(originSchema.enum.ai);
    expect(await db.rawSignal.count()).toBe(1);
  });

  it("invalid な AI 下書き（必須 rawText 欠落）は隔離 invalid に入り、本登録されない", async () => {
    // rawText 欠落 → parse で invalid（失敗行を捨てない）。accept でも本登録されない。
    const intake = await submitAiRawSignalsToQuarantine([{ sourceType: "review" }], db);
    expect(intake.batch.origin).toBe(originSchema.enum.ai);
    expect(intake.pending).toHaveLength(0);
    expect(intake.invalid).toHaveLength(1);

    const accepted = await quarantineRepo.accept(intake.batch.id, undefined, db);
    expect(accepted.accepted).toHaveLength(0);
    expect(await db.rawSignal.count()).toBe(0);
  });
});

// 実画面（task-17 QuickCapture / task-21 CandidateDetail）に配線した payload builder の出力が、
// そのまま quarantine(origin=ai)→accept を通って origin=ai の RawSignal になることを担保する
// （配線の到達性。ボタンは proposed 取得後に submitProposalToQuarantine 経由で本経路を呼ぶ）。
describe("実画面の payload builder → quarantine(origin=ai) 到達性", () => {
  it("QuickCapture: 捉えた観測の下書きが origin=ai で本登録に至る", async () => {
    const fields = {
      ...emptyQuickCaptureFields(),
      sourceType: sourceTypeSchema.enum.review,
      rawText: "競合が値上げしたという観測",
      observedEntity: "競合アプリ",
    };
    const drafts = buildQuarantineDraftsFromFields(fields);
    expect(drafts).not.toBeNull();

    const intake = await submitAiRawSignalsToQuarantine(drafts!, db);
    expect(intake.batch.origin).toBe(originSchema.enum.ai);
    const accepted = await quarantineRepo.accept(intake.batch.id, undefined, db);
    expect(accepted.accepted).toHaveLength(1);
    expect(accepted.accepted[0].rawSignal.origin).toBe(originSchema.enum.ai);
  });

  it("QuickCapture: 必須未充足（rawText 空）なら null（導線実行不可）", () => {
    const fields = { ...emptyQuickCaptureFields(), sourceType: sourceTypeSchema.enum.review };
    expect(buildQuarantineDraftsFromFields(fields)).toBeNull();
  });

  it("CandidateDetail: 不足Evidence提案が origin=ai の RawSignal 下書きに変換され本登録に至る", async () => {
    const drafts = buildMissingEvidenceQuarantineDrafts("請求書 SaaS", [
      { evidenceType: "community", hint: "Reddit を調べる" }, // sourceType としても妥当
      { evidenceType: "spend", hint: "課金データを探す" }, // sourceType に無い → community 既定
    ]);
    expect(drafts).not.toBeNull();
    expect(drafts).toHaveLength(2);
    expect(drafts![0].sourceType).toBe(sourceTypeSchema.enum.community);
    expect(drafts![1].sourceType).toBe(sourceTypeSchema.enum.community);

    const intake = await submitAiRawSignalsToQuarantine(drafts!, db);
    expect(intake.batch.origin).toBe(originSchema.enum.ai);
    const accepted = await quarantineRepo.accept(intake.batch.id, undefined, db);
    expect(accepted.accepted).toHaveLength(2);
    for (const { rawSignal } of accepted.accepted) {
      expect(rawSignal.origin).toBe(originSchema.enum.ai);
    }
  });

  it("CandidateDetail: 提案が空なら null（導線実行不可）", () => {
    expect(buildMissingEvidenceQuarantineDrafts("X", [])).toBeNull();
  });
});
