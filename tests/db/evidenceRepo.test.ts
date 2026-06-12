import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  EvidenceDuplicateLinkError,
  evidenceRepo,
} from "../../lib/db/evidenceRepo";

// task-10 acceptance criteria (spec v2 §7.4 / §8.2 / §8.6):
// - link / unlink / listByCandidate
// - rawSignalId 無しの link が型/実行の両面で不可
// - 重複 link（同 candidate / rawSignal / evidenceType）が弾かれる
// - signalStatsByCandidate の distinctSourceTypes がソース種別で重複排除される
//
// 専用の SQLite ファイルへ向けた PrismaClient を repository に注入し、
// 各テスト前に全テーブルをリセットして決定論性を担保する（dev.db は触らない）。

let dbDir: string;
let db: PrismaClient;

beforeAll(() => {
  // 一時ディレクトリに空の SQLite を用意し、現行スキーマを push する。
  dbDir = mkdtempSync(join(tmpdir(), "mi-evidence-"));
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

// link 対象の Candidate を直接用意する補助（Candidate 作成は task-09 の責務）。
async function makeCandidate(title = "テスト候補"): Promise<string> {
  const candidate = await db.candidate.create({
    data: { displayId: `CND-${title}`, title },
  });
  return candidate.id;
}

// link 対象の RawSignal を直接用意する補助（RawSignal 作成は task-08 の責務）。
let rawSeq = 0;
async function makeRawSignal(
  overrides: {
    sourceType?: string;
    observedUpdate?: Date | null;
  } = {},
): Promise<string> {
  rawSeq += 1;
  const raw = await db.rawSignal.create({
    data: {
      displayId: `RS-20260612-${String(rawSeq).padStart(3, "0")}`,
      sourceType: overrides.sourceType ?? "app_store",
      rawText: "観測事実",
      observedUpdate: overrides.observedUpdate ?? null,
    },
  });
  return raw.id;
}

describe("evidenceRepo.link / unlink / listByCandidate", () => {
  it("links a RawSignal to a Candidate and reads it back", async () => {
    const candidateId = await makeCandidate();
    const rawSignalId = await makeRawSignal();

    const evidence = await evidenceRepo.link(
      { candidateId, rawSignalId, evidenceType: "spend", strength: 4 },
      db,
    );

    expect(evidence.id).toBeTruthy();
    expect(evidence.candidateId).toBe(candidateId);
    expect(evidence.rawSignalId).toBe(rawSignalId);
    expect(evidence.evidenceType).toBe("spend");
    expect(evidence.strength).toBe(4);
    // credibility は Slice 1 では既定 3。
    expect(evidence.credibility).toBe(3);

    const list = await evidenceRepo.listByCandidate(candidateId, db);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(evidence.id);
  });

  it("honors an explicit credibility and note", async () => {
    const candidateId = await makeCandidate();
    const rawSignalId = await makeRawSignal();

    const evidence = await evidenceRepo.link(
      {
        candidateId,
        rawSignalId,
        evidenceType: "search",
        strength: 2,
        credibility: 5,
        note: "検索ボリューム上昇",
      },
      db,
    );

    expect(evidence.credibility).toBe(5);
    expect(evidence.note).toBe("検索ボリューム上昇");
  });

  it("unlinks an evidence by id", async () => {
    const candidateId = await makeCandidate();
    const rawSignalId = await makeRawSignal();
    const evidence = await evidenceRepo.link(
      { candidateId, rawSignalId, evidenceType: "dissatisfaction", strength: 3 },
      db,
    );

    await evidenceRepo.unlink(evidence.id, db);

    expect(await evidenceRepo.listByCandidate(candidateId, db)).toHaveLength(0);
  });

  it("listByCandidate scopes to the given candidate (newest first)", async () => {
    const candidateA = await makeCandidate("候補A");
    const candidateB = await makeCandidate("候補B");
    const raw1 = await makeRawSignal();
    const raw2 = await makeRawSignal();
    const raw3 = await makeRawSignal();

    const first = await evidenceRepo.link(
      { candidateId: candidateA, rawSignalId: raw1, evidenceType: "spend", strength: 3 },
      db,
    );
    const second = await evidenceRepo.link(
      { candidateId: candidateA, rawSignalId: raw2, evidenceType: "search", strength: 3 },
      db,
    );
    await evidenceRepo.link(
      { candidateId: candidateB, rawSignalId: raw3, evidenceType: "spend", strength: 3 },
      db,
    );

    const list = await evidenceRepo.listByCandidate(candidateA, db);
    expect(list.map((e) => e.id)).toEqual([second.id, first.id]);
  });
});

describe("evidenceRepo.link guards (一次ソース必須・重複禁止)", () => {
  it("rejects a link without rawSignalId at runtime (一次ソース必須)", async () => {
    const candidateId = await makeCandidate();
    await expect(
      // @ts-expect-error rawSignalId 必須（型レベルで省略不可。実行時も Zod が弾く）。
      evidenceRepo.link({ candidateId, evidenceType: "spend", strength: 3 }, db),
    ).rejects.toThrow();
  });

  it("rejects an empty rawSignalId at runtime", async () => {
    const candidateId = await makeCandidate();
    await expect(
      evidenceRepo.link(
        { candidateId, rawSignalId: "", evidenceType: "spend", strength: 3 },
        db,
      ),
    ).rejects.toThrow();
  });

  it("rejects an invalid evidenceType (via Zod)", async () => {
    const candidateId = await makeCandidate();
    const rawSignalId = await makeRawSignal();
    await expect(
      evidenceRepo.link(
        { candidateId, rawSignalId, evidenceType: "not_a_type" as never, strength: 3 },
        db,
      ),
    ).rejects.toThrow();
  });

  it("rejects a duplicate link (same candidate / rawSignal / evidenceType)", async () => {
    const candidateId = await makeCandidate();
    const rawSignalId = await makeRawSignal();
    await evidenceRepo.link(
      { candidateId, rawSignalId, evidenceType: "spend", strength: 3 },
      db,
    );

    await expect(
      evidenceRepo.link(
        { candidateId, rawSignalId, evidenceType: "spend", strength: 5 },
        db,
      ),
    ).rejects.toThrow(EvidenceDuplicateLinkError);
  });

  it("allows the same raw signal under a different evidenceType", async () => {
    const candidateId = await makeCandidate();
    const rawSignalId = await makeRawSignal();
    await evidenceRepo.link(
      { candidateId, rawSignalId, evidenceType: "spend", strength: 3 },
      db,
    );

    // 同一 (candidate, rawSignal) でも evidenceType が異なれば別の証拠として成立する。
    const second = await evidenceRepo.link(
      { candidateId, rawSignalId, evidenceType: "dissatisfaction", strength: 2 },
      db,
    );
    expect(second.id).toBeTruthy();
    expect(await evidenceRepo.listByCandidate(candidateId, db)).toHaveLength(2);
  });
});

describe("evidenceRepo.signalStatsByCandidate", () => {
  it("returns empty stats for a candidate with no evidence", async () => {
    const candidateId = await makeCandidate();
    const stats = await evidenceRepo.signalStatsByCandidate(candidateId, db);

    expect(stats.distinctSourceTypes).toBe(0);
    expect(stats.avgStrength).toBe(0);
    expect(stats.hasDirectSpend).toBe(false);
    expect(stats.latestObservedAt).toBeNull();
    expect(stats.strongSignalTypes.size).toBe(0);
  });

  it("dedupes distinctSourceTypes by RawSignal.sourceType (同一 sourceType 2件 → 1)", async () => {
    const candidateId = await makeCandidate();
    // 同一 sourceType (app_store) の RawSignal 2件 + 別 sourceType (review) 1件。
    const rawA = await makeRawSignal({ sourceType: "app_store" });
    const rawB = await makeRawSignal({ sourceType: "app_store" });
    const rawC = await makeRawSignal({ sourceType: "review" });

    await evidenceRepo.link(
      { candidateId, rawSignalId: rawA, evidenceType: "spend", strength: 4 },
      db,
    );
    await evidenceRepo.link(
      { candidateId, rawSignalId: rawB, evidenceType: "search", strength: 2 },
      db,
    );
    await evidenceRepo.link(
      { candidateId, rawSignalId: rawC, evidenceType: "dissatisfaction", strength: 3 },
      db,
    );

    const stats = await evidenceRepo.signalStatsByCandidate(candidateId, db);
    // app_store ×2 + review ×1 → 異なり数は 2。
    expect(stats.distinctSourceTypes).toBe(2);
  });

  it("computes avgStrength / hasDirectSpend / strongSignalTypes", async () => {
    const candidateId = await makeCandidate();
    const rawA = await makeRawSignal({ sourceType: "app_store" });
    const rawB = await makeRawSignal({ sourceType: "review" });
    const rawC = await makeRawSignal({ sourceType: "community" });

    await evidenceRepo.link(
      { candidateId, rawSignalId: rawA, evidenceType: "spend", strength: 4 },
      db,
    );
    await evidenceRepo.link(
      { candidateId, rawSignalId: rawB, evidenceType: "search", strength: 2 },
      db,
    );
    // community は強シグナル集合に含まれない。
    await evidenceRepo.link(
      { candidateId, rawSignalId: rawC, evidenceType: "community", strength: 3 },
      db,
    );

    const stats = await evidenceRepo.signalStatsByCandidate(candidateId, db);
    expect(stats.avgStrength).toBeCloseTo((4 + 2 + 3) / 3);
    expect(stats.hasDirectSpend).toBe(true);
    // {spend, dissatisfaction, search} のうち実在するのは spend / search。
    expect([...stats.strongSignalTypes].sort()).toEqual(["search", "spend"]);
  });

  it("hasDirectSpend is false when no spend evidence is present", async () => {
    const candidateId = await makeCandidate();
    const rawA = await makeRawSignal({ sourceType: "review" });
    await evidenceRepo.link(
      { candidateId, rawSignalId: rawA, evidenceType: "dissatisfaction", strength: 3 },
      db,
    );

    const stats = await evidenceRepo.signalStatsByCandidate(candidateId, db);
    expect(stats.hasDirectSpend).toBe(false);
    expect([...stats.strongSignalTypes]).toEqual(["dissatisfaction"]);
  });

  it("latestObservedAt is the max observedUpdate among linked signals (null if none)", async () => {
    const candidateId = await makeCandidate();
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-06-01T00:00:00.000Z");
    const rawA = await makeRawSignal({ sourceType: "app_store", observedUpdate: older });
    const rawB = await makeRawSignal({ sourceType: "review", observedUpdate: newer });
    const rawC = await makeRawSignal({ sourceType: "sns", observedUpdate: null });

    await evidenceRepo.link(
      { candidateId, rawSignalId: rawA, evidenceType: "spend", strength: 3 },
      db,
    );
    await evidenceRepo.link(
      { candidateId, rawSignalId: rawB, evidenceType: "search", strength: 3 },
      db,
    );
    await evidenceRepo.link(
      { candidateId, rawSignalId: rawC, evidenceType: "community", strength: 3 },
      db,
    );

    const stats = await evidenceRepo.signalStatsByCandidate(candidateId, db);
    expect(stats.latestObservedAt?.toISOString()).toBe(newer.toISOString());
  });

  it("scopes stats to the given candidate only", async () => {
    const candidateA = await makeCandidate("候補A");
    const candidateB = await makeCandidate("候補B");
    const rawA = await makeRawSignal({ sourceType: "app_store" });
    const rawB = await makeRawSignal({ sourceType: "review" });

    await evidenceRepo.link(
      { candidateId: candidateA, rawSignalId: rawA, evidenceType: "spend", strength: 4 },
      db,
    );
    await evidenceRepo.link(
      { candidateId: candidateB, rawSignalId: rawB, evidenceType: "search", strength: 2 },
      db,
    );

    const stats = await evidenceRepo.signalStatsByCandidate(candidateA, db);
    expect(stats.distinctSourceTypes).toBe(1);
    expect(stats.hasDirectSpend).toBe(true);
    expect([...stats.strongSignalTypes]).toEqual(["spend"]);
  });
});
