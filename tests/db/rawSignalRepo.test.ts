import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { rawSignalRepo } from "../../lib/db/rawSignalRepo";
import type { RawSignalInput } from "../../lib/validation/schemas";

// task-08 acceptance criteria (spec v2 §7.2 / §9.3):
// - CRUD（作成→取得→更新→削除）
// - list のフィルタ（sourceType / status / unlinkedOnly / q）
// - 不正 enum を Zod で弾く
// - displayId が RS-YYYYMMDD-NNN 形式で採番される
//
// 専用の SQLite ファイルへ向けた PrismaClient を repository に注入し、
// 各テスト前に全テーブルをリセットして決定論性を担保する（dev.db は触らない）。

let dbDir: string;
let db: PrismaClient;

beforeAll(() => {
  // 一時ディレクトリに空の SQLite を用意し、現行スキーマを push する。
  dbDir = mkdtempSync(join(tmpdir(), "mi-rawsignal-"));
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
  // FK 順に削除（Evidence → RawSignal / Candidate）。
  await db.evidence.deleteMany();
  await db.rawSignal.deleteMany();
  await db.candidate.deleteMany();
});

// 妥当な RawSignal 入力の最小形（テストごとに上書きして使う）。
function inputFixture(overrides: Partial<RawSignalInput> = {}): RawSignalInput {
  return {
    sourceType: "app_store",
    rawText: "観測事実: あるアプリの星1レビューが急増",
    signalTags: [],
    extra: {},
    origin: "manual",
    status: "inbox",
    ...overrides,
  } as RawSignalInput;
}

// Evidence を 1 件作るための Candidate と Evidence を直接用意する補助。
// （Evidence link の作成自体は task-10/12 の責務だが、unlinkedOnly の派生判定を
//   検証するためにここでは DB に直接挿入する。）
async function linkEvidence(rawSignalId: string): Promise<void> {
  const candidate = await db.candidate.create({
    data: { displayId: `CND-${rawSignalId.slice(-3)}`, title: "テスト候補" },
  });
  await db.evidence.create({
    data: {
      candidateId: candidate.id,
      rawSignalId,
      evidenceType: "dissatisfaction",
      strength: 3,
    },
  });
}

describe("rawSignalRepo CRUD", () => {
  it("creates → reads back the same record (JSON fields decoded)", async () => {
    const created = await rawSignalRepo.create(
      inputFixture({
        sourceName: "App Store",
        signalTags: ["pricing", "churn"],
        extra: { stars: 1, complaintTag: "too_expensive" },
      }),
      db,
    );

    expect(created.id).toBeTruthy();
    expect(created.signalTags).toEqual(["pricing", "churn"]);
    expect(created.extra).toEqual({ stars: 1, complaintTag: "too_expensive" });
    // 永続化は JSON 文字列で行われている。
    expect(created.signalTagsJson).toBe('["pricing","churn"]');

    const fetched = await rawSignalRepo.getById(created.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.signalTags).toEqual(["pricing", "churn"]);
    expect(fetched?.extra).toEqual({ stars: 1, complaintTag: "too_expensive" });
  });

  it("returns null from getById for a missing id", async () => {
    expect(await rawSignalRepo.getById("does-not-exist", db)).toBeNull();
  });

  it("updates only the provided fields (others untouched)", async () => {
    const created = await rawSignalRepo.create(
      inputFixture({ note: "before", signalTags: ["a"] }),
      db,
    );

    const updated = await rawSignalRepo.update(
      created.id,
      { status: "archived", signalTags: ["a", "b"] },
      db,
    );

    expect(updated.status).toBe("archived");
    expect(updated.signalTags).toEqual(["a", "b"]);
    // 触れていないフィールドは保持される。
    expect(updated.note).toBe("before");
    expect(updated.rawText).toBe(created.rawText);
    expect(updated.displayId).toBe(created.displayId);
  });

  it("preserves omitted default-bearing fields on update (Codex regression #1)", async () => {
    // signalTags / extra / origin は入力スキーマで default を持つ。update で省略した際に
    // partial の default が materialize して既存値を上書きしないことを保証する。
    const created = await rawSignalRepo.create(
      inputFixture({
        signalTags: ["keep-me"],
        extra: { keep: 1 },
        origin: "import",
      }),
      db,
    );

    // note だけを更新（default を持つフィールドは一切渡さない）。
    const updated = await rawSignalRepo.update(created.id, { note: "touched" }, db);

    expect(updated.note).toBe("touched");
    // 省略したフィールドは default ([] / {} / "manual") に戻らず既存値を保持する。
    expect(updated.signalTags).toEqual(["keep-me"]);
    expect(updated.extra).toEqual({ keep: 1 });
    expect(updated.origin).toBe("import");

    // 再取得しても保持されている（永続化レベルでの確認）。
    const fetched = await rawSignalRepo.getById(created.id, db);
    expect(fetched?.signalTags).toEqual(["keep-me"]);
    expect(fetched?.extra).toEqual({ keep: 1 });
    expect(fetched?.origin).toBe("import");
  });

  it("deletes a record", async () => {
    const created = await rawSignalRepo.create(inputFixture(), db);
    await rawSignalRepo.delete(created.id, db);
    expect(await rawSignalRepo.getById(created.id, db)).toBeNull();
  });
});

describe("rawSignalRepo.list filters", () => {
  it("filters by sourceType", async () => {
    await rawSignalRepo.create(inputFixture({ sourceType: "app_store" }), db);
    await rawSignalRepo.create(inputFixture({ sourceType: "review" }), db);

    const result = await rawSignalRepo.list({ sourceType: "review" }, db);
    expect(result).toHaveLength(1);
    expect(result[0]?.sourceType).toBe("review");
  });

  it("filters by status", async () => {
    await rawSignalRepo.create(inputFixture({ status: "inbox" }), db);
    await rawSignalRepo.create(inputFixture({ status: "ignored" }), db);

    const result = await rawSignalRepo.list({ status: "ignored" }, db);
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("ignored");
  });

  it("filters unlinkedOnly to signals with zero evidence", async () => {
    const linked = await rawSignalRepo.create(inputFixture({ rawText: "linked one" }), db);
    const unlinked = await rawSignalRepo.create(inputFixture({ rawText: "unlinked one" }), db);
    await linkEvidence(linked.id);

    const result = await rawSignalRepo.list({ unlinkedOnly: true }, db);
    expect(result.map((r) => r.id)).toEqual([unlinked.id]);
    expect(result[0]?.evidenceCount).toBe(0);
  });

  it("unlinkedOnly excludes non-inbox rows even with zero evidence (Codex regression #2)", async () => {
    // task doc 定義: unlinkedOnly は「Evidence 0件の inbox」を返す。
    // archived / ignored は Evidence 0件でも inbox ではないため返してはならない。
    const inbox = await rawSignalRepo.create(
      inputFixture({ rawText: "inbox unlinked", status: "inbox" }),
      db,
    );
    await rawSignalRepo.create(
      inputFixture({ rawText: "archived unlinked", status: "archived" }),
      db,
    );
    await rawSignalRepo.create(
      inputFixture({ rawText: "ignored unlinked", status: "ignored" }),
      db,
    );

    const result = await rawSignalRepo.list({ unlinkedOnly: true }, db);
    expect(result.map((r) => r.id)).toEqual([inbox.id]);
    expect(result[0]?.status).toBe("inbox");
  });

  it("reports evidenceCount per row", async () => {
    const linked = await rawSignalRepo.create(inputFixture(), db);
    await linkEvidence(linked.id);

    const result = await rawSignalRepo.list({}, db);
    const row = result.find((r) => r.id === linked.id);
    expect(row?.evidenceCount).toBe(1);
  });

  it("filters by q (contains across rawText / observedEntity / sourceName / note)", async () => {
    await rawSignalRepo.create(inputFixture({ rawText: "needle in the text" }), db);
    await rawSignalRepo.create(
      inputFixture({ rawText: "other", observedEntity: "needle-entity" }),
      db,
    );
    await rawSignalRepo.create(inputFixture({ rawText: "unrelated" }), db);

    const result = await rawSignalRepo.list({ q: "needle" }, db);
    expect(result).toHaveLength(2);
  });

  it("combines filters (status + q)", async () => {
    await rawSignalRepo.create(inputFixture({ rawText: "match me", status: "inbox" }), db);
    await rawSignalRepo.create(inputFixture({ rawText: "match me", status: "archived" }), db);

    const result = await rawSignalRepo.list({ q: "match me", status: "archived" }, db);
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("archived");
  });
});

describe("rawSignalRepo enum validation", () => {
  it("rejects an invalid sourceType on create (via Zod)", async () => {
    await expect(
      rawSignalRepo.create(inputFixture({ sourceType: "not_a_source" as never }), db),
    ).rejects.toThrow();
  });

  it("rejects an invalid status on create (via Zod)", async () => {
    await expect(
      rawSignalRepo.create(inputFixture({ status: "linked" as never }), db),
    ).rejects.toThrow();
  });

  it("rejects an invalid status filter on list (via Zod)", async () => {
    await expect(rawSignalRepo.list({ status: "bogus" }, db)).rejects.toThrow();
  });
});

describe("rawSignalRepo displayId allocation", () => {
  it("assigns an RS-YYYYMMDD-NNN displayId", async () => {
    const created = await rawSignalRepo.create(inputFixture(), db);
    expect(created.displayId).toMatch(/^RS-\d{8}-\d{3}$/);
  });

  it("increments the per-day sequence across creates", async () => {
    const first = await rawSignalRepo.create(inputFixture(), db);
    const second = await rawSignalRepo.create(inputFixture(), db);

    const seq = (id: string) => Number.parseInt(id.split("-").pop() ?? "", 10);
    expect(seq(second.displayId)).toBe(seq(first.displayId) + 1);
    // 同日採番なので日付セグメントは一致する。
    expect(first.displayId.slice(0, 11)).toBe(second.displayId.slice(0, 11));
  });
});
