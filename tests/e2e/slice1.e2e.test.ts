import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { candidateRepo } from "../../lib/db/candidateRepo";
import { STRONG_SIGNAL_TYPES, evidenceRepo } from "../../lib/db/evidenceRepo";
import { parseJson, type ParseResult } from "../../lib/import/parse";
import { quarantineRepo, type QuarantineAcceptResult } from "../../lib/import/quarantineRepo";
import { loadScoringConfig, scoringConfig } from "../../lib/scoring/config";
import { evaluateTop100Gate, type StrongSignalType } from "../../lib/scoring/gateTop100";
import { computeInitialScore } from "../../lib/scoring/initialScore";
import { SOURCE_TYPE_VALUES } from "../../lib/validation/enums";
import type { InitialInputs } from "../../lib/validation/schemas";
import { runSeed, type SeedResult } from "../../seed/seed";
import { backupDb } from "../../scripts/backup-db";
import { exportAll } from "../../scripts/export-all";
import { importAll } from "../../scripts/import-all";

// Slice 1 受け入れ E2E（task-25, spec v2 §21 / §18.4 / §18.5）。
//
// MVP 受け入れ基準（§21）を、seed → import(quarantine→accept) → Candidate 作成 → Evidence
// link → InitialScore 自動計算 → Top100 ゲート抽出 → 棄却(理由コード) → origin 付与 →
// config 重み反映、までを実際の repository / 純粋関数で一巡させて実証する（funnel が一巡する
// ことの結合テスト・§18.5）。さらに export/import の全件往復一致と DB スナップショット
// （§18.4）を確認する。
//
// 専用の SQLite ファイルへ向けた PrismaClient を各 repository に注入し、dev.db は触らない。
// recency 依存を排すため固定時刻（seed の観測日に近い 2026-06-12）を注入する。

const FIXED_NOW = new Date(2026, 5, 12); // 2026-06-12（ローカル）

// import する 100 件のうち、わざと invalid にする行 index（§21: 不正行は隔離）。
const INVALID_IMPORT_INDICES = new Set([7, 23, 50, 71, 99]);
const IMPORT_TOTAL = 100;
const IMPORT_INVALID = INVALID_IMPORT_INDICES.size; // 5
const IMPORT_VALID = IMPORT_TOTAL - IMPORT_INVALID; // 95

let dbDir: string;
let dbPath: string;
let dbUrl: string;
let db: PrismaClient;

// beforeAll で一巡させた結果を各 it から参照する。
let seedResult: SeedResult;
let importParsed: ParseResult;
let acceptResult: QuarantineAcceptResult;
let importedCandidateId: string;
let importedCandidateInputs: InitialInputs;
let importedGatePass: boolean;
let rejectedIds: { englishStudy: string; salesList: string };

/**
 * §10.1 の JSON import 形（`tags`・origin 既定 import）で 100 件を生成する。
 * 0,1 番目は sourceType が異なる valid 行にして（distinctSourceTypes>=2 を作る）、
 * INVALID_IMPORT_INDICES の行は enum 違反 / rawText 空でわざと弾けるようにする。
 */
function makeImportRecords(): unknown[] {
  const records: unknown[] = [];
  for (let i = 0; i < IMPORT_TOTAL; i += 1) {
    if (INVALID_IMPORT_INDICES.has(i)) {
      records.push(
        i % 2 === 1
          ? { sourceType: "not_a_real_source", rawText: `invalid source ${i}` } // enum 違反
          : { sourceType: SOURCE_TYPE_VALUES[i % SOURCE_TYPE_VALUES.length], rawText: "" }, // rawText 空
      );
      continue;
    }
    records.push({
      sourceType: SOURCE_TYPE_VALUES[i % SOURCE_TYPE_VALUES.length],
      rawText: `import 観測レコード ${i}`,
      observedEntity: `IMPORTED-${i}`,
      tags: ["imported", `idx-${i}`],
    });
  }
  return records;
}

/** signalStats の強シグナル集合を Top100 ゲートが要求する集合へ絞り込む（seed と同じ手順）。 */
function toStrongSet(types: ReadonlySet<string>): Set<StrongSignalType> {
  const strong = new Set<StrongSignalType>();
  for (const t of STRONG_SIGNAL_TYPES) {
    if (types.has(t)) strong.add(t);
  }
  return strong;
}

/** Candidate の永続スコア・stats からゲート判定を再計算する（抽出の実体）。 */
async function gatePassFor(candidateId: string): Promise<boolean> {
  const c = await db.candidate.findUniqueOrThrow({ where: { id: candidateId } });
  const stats = await evidenceRepo.signalStatsByCandidate(candidateId, db);
  const gate = evaluateTop100Gate(
    {
      initialScore: c.initialScore ?? 0,
      distinctSourceTypes: stats.distinctSourceTypes,
      strongSignalTypes: toStrongSet(stats.strongSignalTypes),
      legalRisk: c.legalRisk ?? 0,
      opsRisk: c.opsRisk ?? 0,
    },
    scoringConfig,
  );
  return gate.pass;
}

async function candidateIdByKey(key: string): Promise<string> {
  const displayId = seedResult.results.find((r) => r.key === key)?.displayId;
  const row = await db.candidate.findFirstOrThrow({ where: { displayId } });
  return row.id;
}

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-e2e-"));
  dbPath = join(dbDir, "test.db");
  dbUrl = `file:${dbPath}`;
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "ignore",
  });
  // runSeed / repository が動的 import する lib/db/client（シングルトン）の構築が
  // 不正 URL で落ちないよう、テスト DB の URL を環境にも向ける（実書き込みは注入 db のみ）。
  process.env.DATABASE_URL = dbUrl;
  db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  // クリーンな状態から開始（runSeed 自身も冪等にクリアする）。
  await db.evidence.deleteMany();
  await db.scoreSnapshot.deleteMany();
  await db.decisionLog.deleteMany();
  await db.quarantineRow.deleteMany();
  await db.candidate.deleteMany();
  await db.rawSignal.deleteMany();
  await db.importBatch.deleteMany();

  // (1) seed 5 例を投入。
  seedResult = await runSeed(db, FIXED_NOW);

  // (1) import 100 件 → quarantine → accept（不正行は隔離され、本登録されない）。
  importParsed = parseJson(JSON.stringify({ rawSignals: makeImportRecords() }));
  const batch = await quarantineRepo.createBatchFromParse(
    importParsed,
    { format: "json", origin: "import" },
    db,
  );
  acceptResult = await quarantineRepo.accept(batch.batch.id, undefined, db);

  // (2) import 由来の未紐付け Raw Signal から Candidate を作り、Evidence として link する
  //     （一次ソース必須・異なる sourceType 2 種で distinctSourceTypes>=2）。
  const imp0 = await db.rawSignal.findFirstOrThrow({ where: { observedEntity: "IMPORTED-0" } });
  const imp1 = await db.rawSignal.findFirstOrThrow({ where: { observedEntity: "IMPORTED-1" } });

  importedCandidateInputs = {
    spend: 5,
    dissatisfaction: 4,
    pain: 4,
    frequency: 4,
    discoverability: 4,
    substitute: 4,
    legalRisk: 1,
    opsRisk: 1,
  };
  const candidate = await candidateRepo.create(
    {
      title: "import 由来の検証候補",
      productFormFit: [],
      stage: "normalized",
      initialInputs: importedCandidateInputs,
      legalRisk: importedCandidateInputs.legalRisk,
      opsRisk: importedCandidateInputs.opsRisk,
      origin: "manual",
    },
    db,
  );
  importedCandidateId = candidate.id;

  await evidenceRepo.link(
    { candidateId: candidate.id, rawSignalId: imp0.id, evidenceType: "spend", strength: 5 },
    db,
  );
  await evidenceRepo.link(
    {
      candidateId: candidate.id,
      rawSignalId: imp1.id,
      evidenceType: "dissatisfaction",
      strength: 4,
    },
    db,
  );

  // (3) InitialScore を自動計算（市場デマンドのみ・config 重み）して保存。
  const initialScore = computeInitialScore(importedCandidateInputs, scoringConfig);
  await candidateRepo.saveScores(
    candidate.id,
    { initialInputs: importedCandidateInputs, initialScore, scoreConfigVersion: scoringConfig.version },
    db,
  );

  // (4) Top100 ゲート判定。
  importedGatePass = await gatePassFor(candidate.id);

  // (5) 失敗 2 例を理由コード付きで棄却する（分布集計の材料）。
  const englishStudy = await candidateIdByKey("english-study");
  const salesList = await candidateIdByKey("sales-list");
  await candidateRepo.reject({ id: englishStudy, rejectedReasonCode: "low_pain" }, db);
  await candidateRepo.reject({ id: salesList, rejectedReasonCode: "no_purchaser" }, db);
  rejectedIds = { englishStudy, salesList };
});

afterAll(async () => {
  await db.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("Slice 1 受け入れ E2E（§21）", () => {
  it("seed(5例) + import 100件 → quarantine → accept が一巡する", async () => {
    expect(seedResult.candidates).toBe(5);
    expect(seedResult.rawSignals).toBe(13);
    expect(seedResult.evidence).toBe(13);

    // 不正行（enum 違反 / rawText 空）は隔離され、valid だけ pending になる。
    expect(importParsed.valid).toHaveLength(IMPORT_VALID);
    expect(importParsed.invalid).toHaveLength(IMPORT_INVALID);

    // accept で pending だけが本登録される（invalid は本登録されない）。
    expect(acceptResult.accepted).toHaveLength(IMPORT_VALID);
    expect(acceptResult.snapshot.rawSignalCountBefore).toBe(13);
    expect(acceptResult.snapshot.rawSignalCountAfter).toBe(13 + IMPORT_VALID);

    // DB の実件数: seed 13 + import 95 = 108 RawSignal。
    expect(await db.rawSignal.count()).toBe(13 + IMPORT_VALID);
  });

  it("Candidate を作成し Raw Signal を一次ソース必須の Evidence として link できる", async () => {
    const evidences = await evidenceRepo.listByCandidate(importedCandidateId, db);
    expect(evidences).toHaveLength(2);
    // 一次ソース（rawSignalId）が必ず付く。
    for (const e of evidences) {
      expect(e.rawSignalId).toBeTruthy();
    }
    const stats = await evidenceRepo.signalStatsByCandidate(importedCandidateId, db);
    expect(stats.distinctSourceTypes).toBeGreaterThanOrEqual(2);
    expect(stats.hasDirectSpend).toBe(true);
  });

  it("InitialScore（市場デマンドのみ・config 重み）を自動計算できる", async () => {
    const c = await db.candidate.findUniqueOrThrow({ where: { id: importedCandidateId } });
    // §8.1: Σ(axis*weight)。spend5*5 + dissatisfaction4*4 + pain4*3 + frequency4*3
    //        + discoverability4*3 + substitute4*2 = 25+16+12+12+12+8 = 85。
    const expected = computeInitialScore(importedCandidateInputs, scoringConfig);
    expect(expected).toBe(85);
    expect(c.initialScore).toBe(85);
    expect(c.scoreConfigVersion).toBe(scoringConfig.version);
  });

  it("Top100 ゲートで抽出できる（score≥58 ∧ distinct≥2 ∧ 強シグナル≥1 ∧ legal/opsRisk≤3）", async () => {
    // import 由来の候補はゲート通過する。
    expect(importedGatePass).toBe(true);

    // 全候補に対しゲート判定を回し、通過集合を「抽出」する。
    const candidates = await db.candidate.findMany();
    const passing: string[] = [];
    for (const c of candidates) {
      if (await gatePassFor(c.id)) passing.push(c.id);
    }

    // seed の通過 3 例（receipts / sns-posting / invoice）＋ import 由来 1 = 4 件。
    expect(passing).toContain(importedCandidateId);
    expect(passing).toHaveLength(4);

    // 棄却した失敗 2 例はゲートを通らない（抽出に含まれない）。
    expect(passing).not.toContain(rejectedIds.englishStudy);
    expect(passing).not.toContain(rejectedIds.salesList);
  });

  it("棄却を理由コード(enum)付きで残し、reasonCode の分布を集計できる（§15.1）", async () => {
    // 棄却は stage=rejected かつ理由コードが入っている。
    const english = await db.candidate.findUniqueOrThrow({ where: { id: rejectedIds.englishStudy } });
    expect(english.stage).toBe("rejected");
    expect(english.rejectedReasonCode).toBe("low_pain");

    // 分布集計: rejected 候補を理由コードで集計できる。
    const rejected = await db.candidate.findMany({ where: { stage: "rejected" } });
    const distribution = rejected.reduce<Record<string, number>>((acc, c) => {
      const code = c.rejectedReasonCode ?? "(none)";
      acc[code] = (acc[code] ?? 0) + 1;
      return acc;
    }, {});
    expect(distribution).toEqual({ low_pain: 1, no_purchaser: 1 });
  });

  it("全行に origin（manual/import/ai）が付く（§8.9）", async () => {
    const allowed = new Set(["manual", "import", "ai"]);
    const rawSignals = await db.rawSignal.findMany();
    const candidates = await db.candidate.findMany();
    expect(rawSignals.length).toBeGreaterThan(0);
    expect(candidates.length).toBeGreaterThan(0);
    for (const r of rawSignals) {
      expect(allowed.has(r.origin)).toBe(true);
    }
    for (const c of candidates) {
      expect(allowed.has(c.origin)).toBe(true);
    }
    // import 由来の Raw Signal は origin="import" が焼き込まれている。
    const imported = await db.rawSignal.findFirstOrThrow({ where: { observedEntity: "IMPORTED-0" } });
    expect(imported.origin).toBe("import");
  });

  it("scoring.config.json の重み変更がスコアに反映される（§8.10）", () => {
    const baseScore = computeInitialScore(importedCandidateInputs, scoringConfig);

    // spend の重みを 2 倍にした config を読み込み直す（version も上げる・§8.10 運用ルール）。
    const doubledSpend = loadScoringConfig({
      ...scoringConfig,
      version: "2026.06-test-doubled-spend",
      initialWeights: {
        ...scoringConfig.initialWeights,
        spend: scoringConfig.initialWeights.spend * 2,
      },
    });
    const newScore = computeInitialScore(importedCandidateInputs, doubledSpend);

    // spend 軸の寄与（5 * 5 = 25）だけ増える。
    const delta = importedCandidateInputs.spend * scoringConfig.initialWeights.spend;
    expect(newScore).toBe(baseScore + delta);
    expect(newScore).not.toBe(baseScore);
  });
});

describe("バックアップ/復元（§18.4）", () => {
  it("export-all → import-all で全件が往復し、データが一致する", async () => {
    const before = await exportAll(db, FIXED_NOW);

    // 復元（全削除 → 再投入）。auto-snapshot に削除前件数が残る。
    const result = await importAll(before, db);
    const totalRestored = Object.values(result.restored).reduce((s, n) => s + n, 0);
    expect(result.snapshot.totalRowsBefore).toBe(totalRestored);

    const after = await exportAll(db, FIXED_NOW);

    // 全テーブルが id 昇順で完全一致する（id・タイムスタンプ含む全カラム）。
    expect(after.rawSignals).toEqual(before.rawSignals);
    expect(after.candidates).toEqual(before.candidates);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.importBatches).toEqual(before.importBatches);
    expect(after.quarantineRows).toEqual(before.quarantineRows);
    expect(after.scoreSnapshots).toEqual(before.scoreSnapshots);
    expect(after.decisionLogs).toEqual(before.decisionLogs);

    // 件数の裏取り（seed13 + import95 = 108 RawSignal、候補 6）。
    expect(before.rawSignals).toHaveLength(13 + IMPORT_VALID);
    expect(before.candidates).toHaveLength(6);
  });

  it("不整合バンドルで import が途中失敗しても、元データは無傷で残る（原子性・§18.4）", async () => {
    // 取り込み前の完全な状態（往復一致が保証されている健全なバンドル）。
    const before = await exportAll(db, FIXED_NOW);
    const [sampleEvidence] = before.evidence;
    if (sampleEvidence === undefined) throw new Error("前提: evidence が 1 件以上必要");

    // version は正しいが、存在しない Candidate を参照する Evidence を 1 行混ぜた壊れたバンドル。
    // 親（RawSignal/Candidate/ImportBatch）投入後、Evidence 投入で FK 違反 → 途中で失敗する。
    const corruptEvidence = {
      ...sampleEvidence,
      id: "broken-evidence-row",
      candidateId: "candidate-does-not-exist",
    };
    const corrupt = { ...before, evidence: [...before.evidence, corruptEvidence] };

    // 取り込みは失敗する（FK 違反）。
    await expect(importAll(corrupt, db)).rejects.toThrow();

    // 失敗しても 1 件も失われず、全削除がロールバックされて元の状態に戻っている。
    const after = await exportAll(db, FIXED_NOW);
    expect(after.rawSignals).toEqual(before.rawSignals);
    expect(after.candidates).toEqual(before.candidates);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.importBatches).toEqual(before.importBatches);
    expect(after.quarantineRows).toEqual(before.quarantineRows);
    expect(after.scoreSnapshots).toEqual(before.scoreSnapshots);
    expect(after.decisionLogs).toEqual(before.decisionLogs);
  });

  it("backup-db で DB スナップショット（ファイルコピー）が取れる", () => {
    const dest = join(dbDir, "snapshot.db");
    const { src, dest: written } = backupDb({ databaseUrl: dbUrl, destPath: dest });

    expect(written).toBe(dest);
    expect(existsSync(dest)).toBe(true);
    // 元 DB ファイルとバイトサイズが一致する（同一スナップショット）。
    expect(statSync(dest).size).toBe(statSync(src).size);
    expect(src).toBe(dbPath);
  });
});
