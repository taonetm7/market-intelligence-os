import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { candidateRepo, type CandidateCreate } from "../../lib/db/candidateRepo";
import type { InitialInputs } from "../../lib/validation/schemas";

// task-09 acceptance criteria (spec v2 §7.3 / §8.9 / §15.1):
// - CRUD（作成→取得→更新）・setStage
// - reject が rejectedReasonCode 必須・stage=rejected になる（code 無しは reject）
// - saveScores で素点＋派生＋configVersion が往復保存される
// - list フィルタ（stage / minEvidence）・ソート（既定がスコア単独でない）
//
// 専用の SQLite ファイルへ向けた PrismaClient を repository に注入し、
// 各テスト前に全テーブルをリセットして決定論性を担保する（dev.db は触らない）。

let dbDir: string;
let db: PrismaClient;

beforeAll(() => {
  // 一時ディレクトリに空の SQLite を用意し、現行スキーマを push する。
  dbDir = mkdtempSync(join(tmpdir(), "mi-candidate-"));
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

// 妥当な Candidate 入力の最小形（テストごとに上書きして使う）。
// create の入力型は CandidateCreate（stage から 'rejected' を除外）。
function inputFixture(overrides: Partial<CandidateCreate> = {}): CandidateCreate {
  return {
    title: "テスト候補",
    ...overrides,
  } as CandidateCreate;
}

// InitialScore の素点（全軸 0〜5）。
function initialInputsFixture(overrides: Partial<InitialInputs> = {}): InitialInputs {
  return {
    spend: 3,
    pain: 4,
    frequency: 2,
    discoverability: 3,
    dissatisfaction: 4,
    substitute: 2,
    legalRisk: 1,
    opsRisk: 1,
    ...overrides,
  };
}

// Candidate に Evidence を 1 件付ける補助。Evidence は一次ソース（RawSignal）必須なので
// 専用の RawSignal を直接挿入してから join を作る（unique 制約回避のため seed を変える）。
async function addEvidence(candidateId: string, seed: string): Promise<void> {
  const raw = await db.rawSignal.create({
    data: {
      displayId: `RS-20260612-${seed}`,
      sourceType: "app_store",
      rawText: `観測 ${seed}`,
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

describe("candidateRepo CRUD", () => {
  it("creates → reads back the same record (JSON fields decoded)", async () => {
    const created = await candidateRepo.create(
      inputFixture({
        problemFamily: "請求書処理",
        productFormFit: ["web_saas", "ai_tool"],
        initialInputs: initialInputsFixture({ spend: 5 }),
        spendType: "subscription",
      }),
      db,
    );

    expect(created.id).toBeTruthy();
    expect(created.productFormFit).toEqual(["web_saas", "ai_tool"]);
    expect(created.initialInputs).toEqual(initialInputsFixture({ spend: 5 }));
    // 永続化は JSON 文字列で行われている。
    expect(created.productFormFitJson).toBe('["web_saas","ai_tool"]');
    // 派生スコアは create では設定されない（saveScores 専用）。
    expect(created.initialScore).toBeNull();
    expect(created.scoreConfigVersion).toBeNull();
    expect(created.stage).toBe("normalized");

    const fetched = await candidateRepo.getById(created.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.productFormFit).toEqual(["web_saas", "ai_tool"]);
    expect(fetched?.initialInputs).toEqual(initialInputsFixture({ spend: 5 }));
  });

  it("returns null from getById for a missing id", async () => {
    expect(await candidateRepo.getById("does-not-exist", db)).toBeNull();
  });

  it("updates only the provided fields (others untouched)", async () => {
    const created = await candidateRepo.create(
      inputFixture({ title: "before", nextAction: "keep" }),
      db,
    );

    const updated = await candidateRepo.update(
      created.id,
      { title: "after", painStatement: "痛みが強い" },
      db,
    );

    expect(updated.title).toBe("after");
    expect(updated.painStatement).toBe("痛みが強い");
    // 触れていないフィールドは保持される。
    expect(updated.nextAction).toBe("keep");
    expect(updated.displayId).toBe(created.displayId);
    expect(updated.stage).toBe("normalized");
  });

  it("preserves omitted default-bearing fields on update (task-08 regression)", async () => {
    // productFormFit / stage / origin は入力スキーマで default を持つ。update で省略した際に
    // partial の default が materialize して既存値を上書きしないことを保証する（Zod4 挙動）。
    const created = await candidateRepo.create(
      inputFixture({
        productFormFit: ["chrome_extension"],
        stage: "top100",
        origin: "import",
      }),
      db,
    );

    // title だけを更新（default を持つフィールドは一切渡さない）。
    const updated = await candidateRepo.update(created.id, { title: "touched" }, db);

    expect(updated.title).toBe("touched");
    // 省略したフィールドは default (["" ] / "normalized" / "manual") に戻らず既存値を保持する。
    expect(updated.productFormFit).toEqual(["chrome_extension"]);
    expect(updated.stage).toBe("top100");
    expect(updated.origin).toBe("import");

    // 再取得しても保持されている（永続化レベルでの確認）。
    const fetched = await candidateRepo.getById(created.id, db);
    expect(fetched?.productFormFit).toEqual(["chrome_extension"]);
    expect(fetched?.stage).toBe("top100");
    expect(fetched?.origin).toBe("import");
  });

  it("refuses to set stage='rejected' via update (must go through reject(); Codex regression)", async () => {
    // 不変条件 §15.1: rejected への遷移は理由コード必須。update からの直接セットも
    // setStage と同様に弾き、理由コード無しの棄却の迂回路を塞ぐ。
    const created = await candidateRepo.create(inputFixture(), db);
    await expect(
      // @ts-expect-error update スキーマの stage は 'rejected' を除外（型でも弾く）。
      candidateRepo.update(created.id, { stage: "rejected" }, db),
    ).rejects.toThrow();

    // 迂回は成立していない（stage は元のまま、理由コードも付かない）。
    const fetched = await candidateRepo.getById(created.id, db);
    expect(fetched?.stage).toBe("normalized");
    expect(fetched?.rejectedReasonCode).toBeNull();

    // 一方、reject() 経由なら理由コード付きで rejected に遷移できる（正規ルートは健在）。
    const rejected = await candidateRepo.reject(
      { id: created.id, rejectedReasonCode: "low_pain" },
      db,
    );
    expect(rejected.stage).toBe("rejected");
    expect(rejected.rejectedReasonCode).toBe("low_pain");
  });

  it("refuses to create with stage='rejected' (must go through reject(); Codex regression)", async () => {
    // 不変条件 §15.1: rejected への到達は理由コード必須 = reject() 経由のみ。
    // create の stage も settable に限定し、理由コード無しで rejected 候補を新規作成する
    // 迂回路（setStage / update と同型）を塞ぐ。
    await expect(
      // @ts-expect-error create スキーマの stage は 'rejected' を除外（型でも弾く）。
      candidateRepo.create({ title: "棄却済みで作ろうとする", stage: "rejected" }, db),
    ).rejects.toThrow();

    // 迂回は成立していない（rejected な候補は 1 件も作られていない）。
    const all = await candidateRepo.list({}, db);
    expect(all).toHaveLength(0);
  });

  it("assigns a CND-NNN displayId and increments across creates", async () => {
    const first = await candidateRepo.create(inputFixture(), db);
    const second = await candidateRepo.create(inputFixture(), db);

    expect(first.displayId).toMatch(/^CND-\d{3}$/);
    const seq = (id: string) => Number.parseInt(id.split("-").pop() ?? "", 10);
    expect(seq(second.displayId)).toBe(seq(first.displayId) + 1);
  });
});

describe("candidateRepo.setStage", () => {
  it("changes the stage (Zod-validated)", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    const moved = await candidateRepo.setStage(created.id, "top30", db);
    expect(moved.stage).toBe("top30");

    const fetched = await candidateRepo.getById(created.id, db);
    expect(fetched?.stage).toBe("top30");
  });

  it("rejects an invalid stage value (via Zod)", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    await expect(
      candidateRepo.setStage(created.id, "not_a_stage" as never, db),
    ).rejects.toThrow();
  });

  it("refuses to move to 'rejected' (must go through reject(); Codex regression)", async () => {
    // 不変条件 §15.1: rejected への遷移は理由コード必須 = reject() 経由のみ。
    // setStage から rejected に落とすと理由コード無しの棄却ができてしまうため弾く。
    const created = await candidateRepo.create(inputFixture(), db);
    await expect(
      // @ts-expect-error 'rejected' は SettableStage から除外されている（型でも弾く）。
      candidateRepo.setStage(created.id, "rejected", db),
    ).rejects.toThrow();

    // 迂回は成立していない（stage は元のまま、理由コードも付かない）。
    const fetched = await candidateRepo.getById(created.id, db);
    expect(fetched?.stage).toBe("normalized");
    expect(fetched?.rejectedReasonCode).toBeNull();
  });
});

describe("candidateRepo.reject", () => {
  it("requires a reasonCode and sets stage=rejected", async () => {
    const created = await candidateRepo.create(inputFixture({ stage: "top30" }), db);

    const rejected = await candidateRepo.reject(
      { id: created.id, rejectedReasonCode: "no_purchaser", rejectedReason: "誰が払うか不明" },
      db,
    );

    expect(rejected.stage).toBe("rejected");
    expect(rejected.rejectedReasonCode).toBe("no_purchaser");
    expect(rejected.rejectedReason).toBe("誰が払うか不明");

    const fetched = await candidateRepo.getById(created.id, db);
    expect(fetched?.stage).toBe("rejected");
    expect(fetched?.rejectedReasonCode).toBe("no_purchaser");
  });

  it("works without the free-text reason (code alone is enough)", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    const rejected = await candidateRepo.reject(
      { id: created.id, rejectedReasonCode: "low_pain" },
      db,
    );
    expect(rejected.stage).toBe("rejected");
    expect(rejected.rejectedReasonCode).toBe("low_pain");
    expect(rejected.rejectedReason).toBeNull();
  });

  it("refuses to reject without a reasonCode (code missing → throws)", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    await expect(
      // @ts-expect-error rejectedReasonCode は必須。型でも実行時でも弾く。
      candidateRepo.reject({ id: created.id, rejectedReason: "なんとなく" }, db),
    ).rejects.toThrow();

    // 棄却は成立していない（stage は元のまま）。
    const fetched = await candidateRepo.getById(created.id, db);
    expect(fetched?.stage).toBe("normalized");
  });

  it("refuses an invalid reasonCode (via Zod)", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    await expect(
      candidateRepo.reject(
        { id: created.id, rejectedReasonCode: "bogus_code" as never },
        db,
      ),
    ).rejects.toThrow();
  });

  // 改善①: 棄却時刻 rejectedAt を記録し、週次レポートの期間絞りを updatedAt 近似から厳密化する。
  it("records rejectedAt on reject (null before)", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    // 棄却前は rejectedAt 未設定。
    expect(created.rejectedAt).toBeNull();

    const rejected = await candidateRepo.reject(
      { id: created.id, rejectedReasonCode: "no_purchaser" },
      db,
    );
    expect(rejected.rejectedAt).toBeInstanceOf(Date);

    const fetched = await candidateRepo.getById(created.id, db);
    expect(fetched?.rejectedAt).toBeInstanceOf(Date);
  });

  it("keeps rejectedAt fixed even after a later edit moves updatedAt (改善① 期間絞りの不変性)", async () => {
    const created = await candidateRepo.create(inputFixture({ stage: "top30" }), db);
    const rejected = await candidateRepo.reject(
      { id: created.id, rejectedReasonCode: "low_pain" },
      db,
    );
    const rejectedAt = rejected.rejectedAt!;
    expect(rejectedAt).toBeInstanceOf(Date);

    // 棄却後に編集すると updatedAt は動く。@updatedAt のミリ秒精度で差を出すため少し待つ。
    await new Promise((resolve) => setTimeout(resolve, 10));
    const edited = await candidateRepo.update(created.id, { title: "棄却後に書き換えた" }, db);

    // updatedAt は前進したが、rejectedAt は棄却時刻のまま不変（→ 期間絞りがズレない）。
    expect(edited.updatedAt.getTime()).toBeGreaterThan(rejected.updatedAt.getTime());
    expect(edited.rejectedAt?.getTime()).toBe(rejectedAt.getTime());
  });

  it("refreshes rejectedAt to the latest reject when re-rejected", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    const first = await candidateRepo.reject(
      { id: created.id, rejectedReasonCode: "low_pain" },
      db,
    );
    const firstRejectedAt = first.rejectedAt!;

    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await candidateRepo.reject(
      { id: created.id, rejectedReasonCode: "free_only" },
      db,
    );

    // 再 reject は理由コードを付け替え、rejectedAt を最新の棄却判断時刻へ更新する。
    expect(second.rejectedReasonCode).toBe("free_only");
    expect(second.rejectedAt!.getTime()).toBeGreaterThan(firstRejectedAt.getTime());
  });
});

describe("candidateRepo.saveScores", () => {
  it("round-trips raw inputs + derived scores + configVersion", async () => {
    const created = await candidateRepo.create(inputFixture(), db);

    const detailedInputs = { spend: 4, wtp: 3, acquisition: 2, pain: 5 };
    const saved = await candidateRepo.saveScores(
      created.id,
      {
        initialInputs: initialInputsFixture({ spend: 5, pain: 5 }),
        detailedInputs,
        initialScore: 62.5,
        detailedScore: 70,
        signalBonus: 10,
        uncertaintyPenalty: -5,
        confidence: 0.73,
        scoreConfigVersion: "2026.06-v1",
      },
      db,
    );

    expect(saved.initialInputs).toEqual(initialInputsFixture({ spend: 5, pain: 5 }));
    expect(saved.detailedInputs).toEqual(detailedInputs);
    expect(saved.initialScore).toBe(62.5);
    expect(saved.detailedScore).toBe(70);
    expect(saved.signalBonus).toBe(10);
    expect(saved.uncertaintyPenalty).toBe(-5);
    expect(saved.confidence).toBe(0.73);
    expect(saved.scoreConfigVersion).toBe("2026.06-v1");

    // 永続化レベルでも往復している。
    const fetched = await candidateRepo.getById(created.id, db);
    expect(fetched?.initialInputs).toEqual(initialInputsFixture({ spend: 5, pain: 5 }));
    expect(fetched?.detailedInputs).toEqual(detailedInputs);
    expect(fetched?.confidence).toBe(0.73);
    expect(fetched?.scoreConfigVersion).toBe("2026.06-v1");
  });

  it("updates only the provided score fields (others untouched)", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    await candidateRepo.saveScores(
      created.id,
      { initialScore: 50, scoreConfigVersion: "v1" },
      db,
    );

    // confidence だけを後から保存しても initialScore / configVersion は保持される。
    const saved = await candidateRepo.saveScores(created.id, { confidence: 0.9 }, db);
    expect(saved.confidence).toBe(0.9);
    expect(saved.initialScore).toBe(50);
    expect(saved.scoreConfigVersion).toBe("v1");
  });

  it("rejects out-of-range raw inputs (via Zod)", async () => {
    const created = await candidateRepo.create(inputFixture(), db);
    await expect(
      candidateRepo.saveScores(
        created.id,
        { initialInputs: initialInputsFixture({ spend: 9 as never }) },
        db,
      ),
    ).rejects.toThrow();
  });
});

describe("candidateRepo.list", () => {
  it("filters by stage", async () => {
    await candidateRepo.create(inputFixture({ stage: "normalized" }), db);
    await candidateRepo.create(inputFixture({ stage: "top30" }), db);

    const result = await candidateRepo.list({ stage: "top30" }, db);
    expect(result).toHaveLength(1);
    expect(result[0]?.stage).toBe("top30");
  });

  it("reports evidenceCount and filters by minEvidence", async () => {
    const none = await candidateRepo.create(inputFixture({ title: "no evidence" }), db);
    const two = await candidateRepo.create(inputFixture({ title: "two evidence" }), db);
    await addEvidence(two.id, "001");
    await addEvidence(two.id, "002");

    const all = await candidateRepo.list({}, db);
    expect(all.find((c) => c.id === none.id)?.evidenceCount).toBe(0);
    expect(all.find((c) => c.id === two.id)?.evidenceCount).toBe(2);

    const filtered = await candidateRepo.list({ minEvidence: 1 }, db);
    expect(filtered.map((c) => c.id)).toEqual([two.id]);
  });

  it("default sort is NOT score-alone (createdAt desc, ignores score)", async () => {
    // a を先に作成し、a に高スコアを与える。既定ソートがスコア順なら a が先頭に来るが、
    // 既定は createdAt 降順（過信防止 §9.4）なので、後から作られた b が先頭に来る。
    const a = await candidateRepo.create(inputFixture({ title: "older, high score" }), db);
    const b = await candidateRepo.create(inputFixture({ title: "newer, low score" }), db);
    await candidateRepo.saveScores(a.id, { initialScore: 99 }, db);
    await candidateRepo.saveScores(b.id, { initialScore: 1 }, db);

    const def = (await candidateRepo.list({}, db)).map((c) => c.id);
    // 既定はスコアを見ない: createdAt 降順で新しい b が先頭（高スコアの a ではない）。
    expect(def).toEqual([b.id, a.id]);

    // 明示的にスコア順を要求したときだけ a（99）が先頭に来る。
    const byScore = (await candidateRepo.list({ sortBy: "initialScore" }, db)).map((c) => c.id);
    expect(byScore).toEqual([a.id, b.id]);
  });

  it("sorts by confidence when explicitly requested", async () => {
    const lo = await candidateRepo.create(inputFixture(), db);
    const hi = await candidateRepo.create(inputFixture(), db);
    await candidateRepo.saveScores(lo.id, { confidence: 0.2 }, db);
    await candidateRepo.saveScores(hi.id, { confidence: 0.8 }, db);

    const byConfidence = (await candidateRepo.list({ sortBy: "confidence" }, db)).map((c) => c.id);
    expect(byConfidence).toEqual([hi.id, lo.id]);
  });

  it("sorts by evidenceCount when explicitly requested", async () => {
    const few = await candidateRepo.create(inputFixture(), db);
    const many = await candidateRepo.create(inputFixture(), db);
    await addEvidence(many.id, "101");
    await addEvidence(many.id, "102");
    await addEvidence(few.id, "103");

    const byEvidence = (await candidateRepo.list({ sortBy: "evidenceCount" }, db)).map((c) => c.id);
    expect(byEvidence).toEqual([many.id, few.id]);
  });

  it("rejects an invalid stage filter on list (via Zod)", async () => {
    await expect(candidateRepo.list({ stage: "bogus" }, db)).rejects.toThrow();
  });
});
