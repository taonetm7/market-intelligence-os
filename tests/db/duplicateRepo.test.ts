import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { candidateRepo, type CandidateCreate } from "../../lib/db/candidateRepo";
import { duplicateRepo } from "../../lib/db/duplicateRepo";
import { DEFAULT_THRESHOLD } from "../../lib/duplicate/similarity";
import { rejectedReasonCodeSchema, stageSchema } from "../../lib/validation/enums";

// task-34 duplicate-detect — duplicateRepo の受入条件テスト（Codex 指摘対応・Phase 2）。
// spec v2 §9.7 / §3.3。純粋関数 similarity の単体テスト（tests/duplicate/similarity.test.ts）とは別に、
// DB を経由する suggest / suggestAll の受入条件を直接検証する:
// - suggest が閾値以上の候補と一致理由(matched)を返す
// - 自分自身 / rejected / archived を除外する
// - threshold / limit が効く
// - tags が「紐付く RawSignal の signalTags」から集約され類似度に反映される
// - suggestAll が全候補ペアで上記を満たす（自分自身/rejected/archived 除外含む）
//
// candidateRepo.test.ts と同方式: 専用 SQLite を用意し PrismaClient を repository に注入する。
// dev.db は触らない。enum 文字列は stageSchema.enum 経由（直書き禁止）。import は相対パス。

let dbDir: string;
let db: PrismaClient;

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-duplicate-"));
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
  // FK 順に削除（Candidate の子 → Candidate / RawSignal）。
  await db.evidence.deleteMany();
  await db.scoreSnapshot.deleteMany();
  await db.decisionLog.deleteMany();
  await db.candidate.deleteMany();
  await db.rawSignal.deleteMany();
});

let rawSeq = 0;

/** §9.7 のテキスト素性を埋めた基準候補（差分を上書きして使う）。create は default 持ち
 *  フィールド（productFormFit/origin/stage）を補うため、入力は CandidateCreate へキャストする。 */
function featureFixture(overrides: Record<string, unknown> = {}): CandidateCreate {
  return {
    title: "請求書候補",
    problemFamily: "請求書の作成と送付",
    targetUser: "個人事業主",
    contextTrigger: "月末の締め作業",
    painStatement: "毎月手作業で請求書を作るのが面倒",
    currentSubstitute: "Excel テンプレート",
    ...overrides,
  } as CandidateCreate;
}

/** Candidate を作成する（create は rejected 以外の stage を受け付ける）。 */
async function createCandidate(overrides: Record<string, unknown> = {}) {
  return candidateRepo.create(featureFixture(overrides), db);
}

/** Candidate に signalTags 付き RawSignal を 1 件紐付ける（tags 集約の経路を作る）。 */
async function attachTags(candidateId: string, tags: string[]): Promise<void> {
  rawSeq += 1;
  const raw = await db.rawSignal.create({
    data: {
      displayId: `RS-DUP-${rawSeq}`,
      sourceType: "app_store",
      rawText: `観測 ${rawSeq}`,
      signalTagsJson: JSON.stringify(tags),
    },
  });
  await db.evidence.create({
    data: {
      candidateId,
      rawSignalId: raw.id,
      evidenceType: "dissatisfaction",
      strength: 3,
    },
  });
}

/** 無関係な候補の素性（テキストもタグも被らない）。 */
function unrelatedOverrides(): Record<string, unknown> {
  return {
    title: "観光候補",
    problemFamily: "観光地の混雑予測",
    targetUser: "自治体の観光課",
    contextTrigger: "大型連休",
    painStatement: "人出が読めず人員配置に失敗する",
    currentSubstitute: "過去の勘",
  };
}

/** problemFamily / painStatement / targetUser を共有する近い候補（明確に閾値以上）。 */
function nearDuplicateOverrides(): Record<string, unknown> {
  return {
    title: "請求書候補（別表現）",
    problemFamily: "請求書の作成と送付",
    targetUser: "個人事業主",
    contextTrigger: "監査対応",
    painStatement: "毎月手作業で請求書を作るのが面倒",
    currentSubstitute: "基幹システム",
  };
}

describe("duplicateRepo.suggest", () => {
  it("閾値以上の類似候補を score と一致理由 matched 付きで返す", async () => {
    const target = await createCandidate();
    const near = await createCandidate(nearDuplicateOverrides());
    await createCandidate(unrelatedOverrides());

    const result = await duplicateRepo.suggest(target.id, {}, db);

    // 近い候補だけが返る（無関係は閾値未満で落ちる）。
    expect(result.map((r) => r.candidate.id)).toEqual([near.id]);
    const hit = result[0];
    expect(hit.score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
    expect(hit.score).toBeLessThan(1);
    // 一致理由（なぜ似ているか）に共有項目が挙がる。
    const fields = hit.matched.map((m) => m.field);
    expect(fields).toContain("problemFamily");
    expect(fields).toContain("painStatement");
    // matched は類似度降順。
    const sims = hit.matched.map((m) => m.similarity);
    expect([...sims].sort((x, y) => y - x)).toEqual(sims);
  });

  it("自分自身は候補に含めない", async () => {
    const target = await createCandidate();
    // 完全一致する別候補を作っても、自分自身は結果に出ない。
    await createCandidate();

    const result = await duplicateRepo.suggest(target.id, {}, db);
    expect(result.every((r) => r.candidate.id !== target.id)).toBe(true);
  });

  it("rejected の候補を重複候補から除外する", async () => {
    const target = await createCandidate();
    const near = await createCandidate(nearDuplicateOverrides());

    // 除外前は near が出る。
    const before = await duplicateRepo.suggest(target.id, {}, db);
    expect(before.map((r) => r.candidate.id)).toContain(near.id);

    // 棄却すると除外される（理由コード必須・reject 経由）。
    await candidateRepo.reject({ id: near.id, rejectedReasonCode: rejectedReasonCodeSchema.enum.too_competitive }, db);
    const after = await duplicateRepo.suggest(target.id, {}, db);
    expect(after.map((r) => r.candidate.id)).not.toContain(near.id);
  });

  it("archived の候補を重複候補から除外する", async () => {
    const target = await createCandidate();
    const near = await createCandidate(nearDuplicateOverrides());

    await candidateRepo.setStage(near.id, stageSchema.enum.archived, db);
    const result = await duplicateRepo.suggest(target.id, {}, db);
    expect(result.map((r) => r.candidate.id)).not.toContain(near.id);
  });

  it("対象 candidate 自身が rejected / archived ならサジェストしない（空配列）", async () => {
    const target = await createCandidate();
    await createCandidate(); // 完全一致の相手は居る

    await candidateRepo.reject({ id: target.id, rejectedReasonCode: rejectedReasonCodeSchema.enum.too_competitive }, db);
    expect(await duplicateRepo.suggest(target.id, {}, db)).toEqual([]);
  });

  it("存在しない candidateId は空配列（404 ではなく「該当なし」）", async () => {
    expect(await duplicateRepo.suggest("does-not-exist", {}, db)).toEqual([]);
  });

  it("threshold を上げると閾値未満の候補は返らない", async () => {
    const target = await createCandidate();
    await createCandidate(nearDuplicateOverrides()); // score は 1 未満

    // 既定では出るが、閾値 0.95 では落ちる。
    expect(await duplicateRepo.suggest(target.id, {}, db)).toHaveLength(1);
    expect(await duplicateRepo.suggest(target.id, { threshold: 0.95 }, db)).toEqual([]);
  });

  it("limit でスコア降順の上位 N 件に絞る", async () => {
    const target = await createCandidate();
    const exact = await createCandidate(); // 完全一致（score 最大）
    await createCandidate(nearDuplicateOverrides()); // 部分一致（より低い）

    const all = await duplicateRepo.suggest(target.id, {}, db);
    expect(all).toHaveLength(2);

    const limited = await duplicateRepo.suggest(target.id, { limit: 1 }, db);
    expect(limited).toHaveLength(1);
    // 上位＝スコア最大の完全一致候補。
    expect(limited[0].candidate.id).toBe(exact.id);
    expect(limited[0].score).toBeGreaterThanOrEqual(all[1].score);
  });

  it("tags は紐付く RawSignal の signalTags から集約され類似度に反映される", async () => {
    // テキストは problemFamily だけ共有させ（他の任意項目は未設定＝両側空で分母から除外）、
    // tags の差で結果が変わることを示す。任意の文字列項目は null 不可なので未指定で作る。
    const sparse = (): Promise<{ id: string }> =>
      candidateRepo.create({ title: "tags候補", problemFamily: "請求書の作成" } as CandidateCreate, db);
    const target = await sparse();
    await attachTags(target.id, ["invoicing", "automation"]);

    const sameTags = await sparse();
    await attachTags(sameTags.id, ["invoicing", "automation"]);

    const otherTags = await sparse();
    await attachTags(otherTags.id, ["tourism"]);

    const result = await duplicateRepo.suggest(target.id, {}, db);
    const sameHit = result.find((r) => r.candidate.id === sameTags.id);
    const otherHit = result.find((r) => r.candidate.id === otherTags.id);

    // 同一タグの相手は tags が一致理由に挙がり、より高スコア。
    expect(sameHit).toBeDefined();
    expect(sameHit?.matched.map((m) => m.field)).toContain("tags");
    // タグが食い違う相手は tags が一致理由に挙がらない。
    expect(otherHit?.matched.map((m) => m.field) ?? []).not.toContain("tags");
    expect(sameHit!.score).toBeGreaterThan(otherHit!.score);
  });

  it("API 応答に内部結合（evidences）を漏らさない（素の Candidate を返す）", async () => {
    const target = await createCandidate();
    await attachTags(target.id, ["invoicing"]);
    const near = await createCandidate(nearDuplicateOverrides());
    await attachTags(near.id, ["invoicing"]);

    const result = await duplicateRepo.suggest(target.id, {}, db);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].candidate).not.toHaveProperty("evidences");
  });
});

describe("duplicateRepo.suggestAll", () => {
  it("閾値以上のペアを score・matched 付き・スコア降順で返す（自分自身ペアは無し）", async () => {
    const target = await createCandidate();
    const near = await createCandidate(nearDuplicateOverrides());
    await createCandidate(unrelatedOverrides());

    const pairs = await duplicateRepo.suggestAll({}, db);

    // target × near のペアが拾われる（無向・i<j、自己ペアは作らない）。
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const ids = new Set([target.id, near.id]);
    const hit = pairs.find((p) => ids.has(p.a.id) && ids.has(p.b.id));
    expect(hit).toBeDefined();
    expect(hit?.a.id).not.toBe(hit?.b.id);
    expect(hit?.score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
    expect((hit?.matched ?? []).map((m) => m.field)).toContain("problemFamily");

    // スコア降順。
    const scores = pairs.map((p) => p.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });

  it("rejected / archived を含むペアは作らない", async () => {
    const target = await createCandidate();
    const rejected = await createCandidate(nearDuplicateOverrides());
    const archived = await createCandidate(nearDuplicateOverrides());

    await candidateRepo.reject({ id: rejected.id, rejectedReasonCode: rejectedReasonCodeSchema.enum.too_competitive }, db);
    await candidateRepo.setStage(archived.id, stageSchema.enum.archived, db);

    const pairs = await duplicateRepo.suggestAll({}, db);
    const involved = new Set(pairs.flatMap((p) => [p.a.id, p.b.id]));
    expect(involved.has(rejected.id)).toBe(false);
    expect(involved.has(archived.id)).toBe(false);
    // 残った target は退役候補と組まされない（生きた相手が居なければ 0 ペア）。
    expect(involved.has(target.id)).toBe(false);
  });

  it("threshold / limit が効く", async () => {
    await createCandidate();
    await createCandidate(); // 完全一致ペア（score 最大）
    await createCandidate(nearDuplicateOverrides());

    // 高閾値では完全一致ペアだけが残る。
    const strict = await duplicateRepo.suggestAll({ threshold: 0.95 }, db);
    expect(strict.length).toBeGreaterThanOrEqual(1);
    expect(strict.every((p) => p.score >= 0.95)).toBe(true);

    // limit で件数を絞れる。
    const limited = await duplicateRepo.suggestAll({ limit: 1 }, db);
    expect(limited).toHaveLength(1);
  });
});
