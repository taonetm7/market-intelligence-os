import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseJson } from "../../lib/import/parse";
import {
  QuarantineAlreadyAcceptedError,
  QuarantineInvalidRowError,
  QuarantineNotFoundError,
  quarantineRepo,
} from "../../lib/import/quarantineRepo";

// task-15 acceptance criteria (spec v2 §10.1 / §11.2):
// - import で valid/invalid が quarantine に入る
// - accept で pending 行のみ RawSignal 本登録され origin が付く
// - invalid 行は accept されない
// - 一覧 API が batch 単位で pending/invalid/accepted を返す
//
// 専用の SQLite ファイルへ向けた PrismaClient を repository に注入し、各テスト前に
// 全テーブルをリセットして決定論性を担保する（dev.db は触らない）。

let dbDir: string;
let db: PrismaClient;

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), "mi-quarantine-"));
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
  // FK 順に削除（QuarantineRow → ImportBatch、Evidence → RawSignal）。
  await db.quarantineRow.deleteMany();
  await db.importBatch.deleteMany();
  await db.evidence.deleteMany();
  await db.rawSignal.deleteMany();
});

// §10.1 の正常な import 行 1 件。
function validSignal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceType: "review",
    sourceName: "App Store",
    sourceUrl: "https://example.com/app",
    rawText: "星1〜3に『日本語対応が弱い』が反復",
    observedEntity: "○○ App",
    tags: ["localization"],
    ...overrides,
  };
}

// valid 2 件 + invalid 1 件（sourceType の enum 不正）が混在するパース結果を作る。
function mixedParse() {
  return parseJson({
    rawSignals: [
      validSignal(), // row 1: valid
      validSignal({ sourceType: "blog" }), // row 2: invalid (enum)
      validSignal({ sourceName: "Google Play" }), // row 3: valid
    ],
  });
}

// 行更新（quarantineRow.updateMany）だけが必ず失敗する PrismaClient ラッパ。
// accept の「本登録 → 行更新」のうち行更新が落ちたとき、作成済み RawSignal が補償削除され
// 不整合（RawSignal だけ残る）が起きないことを検証するために使う（Codex 指摘2）。
function withFailingRowUpdate(real: PrismaClient): PrismaClient {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "quarantineRow") {
        const qr = target.quarantineRow;
        return new Proxy(qr, {
          get(t, p) {
            if (p === "updateMany") {
              return async () => {
                throw new Error("simulated quarantineRow.updateMany failure");
              };
            }
            const value = Reflect.get(t, p);
            return typeof value === "function" ? value.bind(t) : value;
          },
        });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("createBatchFromParse（import → quarantine）", () => {
  it("valid 行は pending、invalid 行は invalid として隔離される（本登録はされない）", async () => {
    const result = await quarantineRepo.createBatchFromParse(
      mixedParse(),
      { format: "json" },
      db,
    );

    expect(result.batch.origin).toBe("import"); // 既定 origin
    expect(result.batch.format).toBe("json");
    expect(result.pending).toHaveLength(2);
    expect(result.invalid).toHaveLength(1);

    // invalid 行は理由を保持する（§10.1 step6）。
    expect(result.invalid[0]?.rowNumber).toBe(2);
    expect(result.invalid[0]?.errorsJson).toContain("sourceType");
    expect(result.invalid[0]?.payloadJson).toBeNull();

    // pending 行は payload（本登録の元データ）を保持する。
    expect(result.pending[0]?.payloadJson).toContain("review");

    // この時点では RawSignal は 1 件も本登録されていない（即本登録しない・§10.1 step4）。
    expect(await db.rawSignal.count()).toBe(0);
  });

  it("pending 行の rowNumber は元入力行を保持する（invalid 混在でズレない・Codex 指摘3）", async () => {
    // mixedParse: row1 valid / row2 invalid / row3 valid。
    const result = await quarantineRepo.createBatchFromParse(
      mixedParse(),
      { format: "json" },
      db,
    );

    // pending は元入力の 1 行目と 3 行目（valid 配列順の 1,2 ではない）。
    expect(result.pending.map((r) => r.rowNumber).sort((a, b) => a - b)).toEqual([1, 3]);
    // invalid は元入力の 2 行目。
    expect(result.invalid[0]?.rowNumber).toBe(2);
  });

  it("origin=ai のバッチは valid payload の origin を ai に焼き込む（§11.2）", async () => {
    const result = await quarantineRepo.createBatchFromParse(
      parseJson({ rawSignals: [validSignal()] }),
      { format: "json", origin: "ai" },
      db,
    );

    expect(result.batch.origin).toBe("ai");
    const payload = JSON.parse(result.pending[0]!.payloadJson!);
    expect(payload.origin).toBe("ai");
  });
});

describe("accept（quarantine → RawSignal 本登録）", () => {
  it("pending 行のみ RawSignal に本登録され、batch の origin が付く", async () => {
    const batch = await quarantineRepo.createBatchFromParse(
      mixedParse(),
      { format: "json", origin: "ai" },
      db,
    );

    const result = await quarantineRepo.accept(batch.batch.id, undefined, db);

    // pending 2 件のみ本登録（invalid 1 件は対象外）。
    expect(result.accepted).toHaveLength(2);
    expect(await db.rawSignal.count()).toBe(2);

    // 本登録された RawSignal に origin=ai が付く（§11.2）。
    for (const { rawSignal } of result.accepted) {
      expect(rawSignal.origin).toBe("ai");
    }

    // 行は accepted に遷移し、rawSignalId が記録される（本登録の証跡）。
    const rows = await db.quarantineRow.findMany({ where: { batchId: batch.batch.id } });
    const accepted = rows.filter((r) => r.status === "accepted");
    expect(accepted).toHaveLength(2);
    expect(accepted.every((r) => r.rawSignalId !== null)).toBe(true);

    // auto-snapshot（§18.4 最小実装）: 件数が記録される。
    expect(result.snapshot.rawSignalCountBefore).toBe(0);
    expect(result.snapshot.acceptedCount).toBe(2);
    expect(result.snapshot.rawSignalCountAfter).toBe(2);
  });

  it("rowIds で選択した pending 行だけを本登録する", async () => {
    const batch = await quarantineRepo.createBatchFromParse(
      mixedParse(),
      { format: "json" },
      db,
    );
    const [first] = batch.pending;

    const result = await quarantineRepo.accept(batch.batch.id, [first.id], db);

    expect(result.accepted).toHaveLength(1);
    expect(await db.rawSignal.count()).toBe(1);
    // 残り 1 件の pending は未登録のまま。
    const view = (await quarantineRepo.listQuarantine(batch.batch.id, db))[0];
    expect(view.pending).toHaveLength(1);
    expect(view.accepted).toHaveLength(1);
  });

  it("invalid 行を accept しようとすると QuarantineInvalidRowError で弾かれ本登録されない", async () => {
    const batch = await quarantineRepo.createBatchFromParse(
      mixedParse(),
      { format: "json" },
      db,
    );
    const [invalidRow] = batch.invalid;

    await expect(
      quarantineRepo.accept(batch.batch.id, [invalidRow.id], db),
    ).rejects.toBeInstanceOf(QuarantineInvalidRowError);

    // 本登録は 1 件も発生していない。
    expect(await db.rawSignal.count()).toBe(0);
  });

  it("存在しない batchId は QuarantineNotFoundError", async () => {
    await expect(
      quarantineRepo.accept("nonexistent-batch", undefined, db),
    ).rejects.toBeInstanceOf(QuarantineNotFoundError);
  });

  it("バッチに属さない rowId 指定は QuarantineNotFoundError", async () => {
    const batch = await quarantineRepo.createBatchFromParse(
      parseJson({ rawSignals: [validSignal()] }),
      { format: "json" },
      db,
    );
    await expect(
      quarantineRepo.accept(batch.batch.id, ["bogus-row-id"], db),
    ).rejects.toBeInstanceOf(QuarantineNotFoundError);
  });

  it("再 accept は冪等（accepted 行は再登録されない）", async () => {
    const batch = await quarantineRepo.createBatchFromParse(
      parseJson({ rawSignals: [validSignal()] }),
      { format: "json" },
      db,
    );
    await quarantineRepo.accept(batch.batch.id, undefined, db);
    // 2 回目: pending が無いので何も本登録されない。
    const second = await quarantineRepo.accept(batch.batch.id, undefined, db);
    expect(second.accepted).toHaveLength(0);
    expect(await db.rawSignal.count()).toBe(1);
  });

  it("accepted 済み行を rowIds で明示 accept すると QuarantineAlreadyAcceptedError（再登録されない）", async () => {
    const batch = await quarantineRepo.createBatchFromParse(
      parseJson({ rawSignals: [validSignal()] }),
      { format: "json" },
      db,
    );
    const [pending] = batch.pending;
    await quarantineRepo.accept(batch.batch.id, [pending.id], db);
    expect(await db.rawSignal.count()).toBe(1);

    // 同じ行を再度 rowIds で指定 → 矛盾要求として弾かれ、二重本登録は起きない（Codex 指摘1）。
    await expect(
      quarantineRepo.accept(batch.batch.id, [pending.id], db),
    ).rejects.toBeInstanceOf(QuarantineAlreadyAcceptedError);
    expect(await db.rawSignal.count()).toBe(1);
  });

  it("本登録後の行更新が失敗したら作成済み RawSignal を補償削除して不整合を残さない", async () => {
    const batch = await quarantineRepo.createBatchFromParse(
      parseJson({ rawSignals: [validSignal()] }),
      { format: "json" },
      db,
    );

    // 行更新だけが必ず落ちる db で accept → 例外が伝播する。
    await expect(
      quarantineRepo.accept(batch.batch.id, undefined, withFailingRowUpdate(db)),
    ).rejects.toThrow();

    // 補償削除により RawSignal は残らず、行も pending のまま（"RawSignal だけ存在" を防ぐ）。
    expect(await db.rawSignal.count()).toBe(0);
    const view = (await quarantineRepo.listQuarantine(batch.batch.id, db))[0];
    expect(view.pending).toHaveLength(1);
    expect(view.accepted).toHaveLength(0);
  });
});

describe("listQuarantine（隔離一覧）", () => {
  it("batch 単位で pending / invalid / accepted を返す", async () => {
    const batch = await quarantineRepo.createBatchFromParse(
      mixedParse(),
      { format: "json" },
      db,
    );
    // 1 件だけ accept して accepted を作る。
    await quarantineRepo.accept(batch.batch.id, [batch.pending[0].id], db);

    const views = await quarantineRepo.listQuarantine(undefined, db);
    expect(views).toHaveLength(1);
    const view = views[0];
    expect(view.batch.id).toBe(batch.batch.id);
    expect(view.pending).toHaveLength(1); // 2 - 1 accepted
    expect(view.invalid).toHaveLength(1);
    expect(view.accepted).toHaveLength(1);
  });

  it("batchId で 1 バッチに絞れる。新しいバッチが先頭（決定的順序）", async () => {
    const first = await quarantineRepo.createBatchFromParse(
      parseJson({ rawSignals: [validSignal()] }),
      { format: "json" },
      db,
    );
    const second = await quarantineRepo.createBatchFromParse(
      parseJson({ rawSignals: [validSignal()] }),
      { format: "csv" },
      db,
    );

    const all = await quarantineRepo.listQuarantine(undefined, db);
    expect(all).toHaveLength(2);
    // createdAt 降順 → 後から作った second が先頭（tie-break で決定的）。
    expect(all[0].batch.id).toBe(second.batch.id);

    const only = await quarantineRepo.listQuarantine(first.batch.id, db);
    expect(only).toHaveLength(1);
    expect(only[0].batch.id).toBe(first.batch.id);
  });
});
