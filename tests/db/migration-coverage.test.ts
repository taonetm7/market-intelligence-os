import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

// task-40 Phase 2 — 移行の網羅性（指摘①）と内容一致検証（指摘②）を Postgres 非依存で担保する。
//
// 指摘①: export-all/import-all は task-25 時点の 7 モデルのみを対象にしており、後続追加モデル
//   （DuplicateDismissal=task-35 / Watchlist=task-36）が移行から漏れる＝データ損失リスクがあった。
//   → EXPORTED_MODEL_NAMES（全件移行の単一の正）が実スキーマ（DMMF）の全モデルと一致することを
//     検証し、「モデルを追加したら移行対象に入れ忘れる」のを CI で検出する。
// 指摘②: 往復一致が総件数のみで、内容のズレを見逃す。→ diffBundles の検出力を検証する。
//
// いずれも純粋・DB 非依存（Postgres 不要）なので通常 CI（SQLite）で常時走る。import は相対パス。

import { EXPORTED_MODEL_NAMES, type ExportBundle } from "../../scripts/export-all";
import { diffBundles } from "../../scripts/migrate-sqlite-to-pg";

/** テスト用の空バンドル（全テーブル空）。 */
function emptyBundle(): ExportBundle {
  return {
    version: 1,
    exportedAt: "2026-06-18T00:00:00.000Z",
    rawSignals: [],
    candidates: [],
    evidence: [],
    importBatches: [],
    quarantineRows: [],
    scoreSnapshots: [],
    decisionLogs: [],
    duplicateDismissals: [],
    watchlists: [],
  };
}

describe("移行の網羅性（指摘①: 全モデルが移行対象）", () => {
  it("EXPORTED_MODEL_NAMES が Prisma 実スキーマ（DMMF）の全モデルと一致する", () => {
    const dmmfModels = Prisma.dmmf.datamodel.models.map((m) => m.name).sort();
    const exported = [...EXPORTED_MODEL_NAMES].sort();
    // 差分があれば「export 漏れ（移行対象に未追加）」or「実在しないモデルの列挙」を意味する。
    expect(exported).toEqual(dmmfModels);
  });

  it("後続追加モデル（DuplicateDismissal / Watchlist）が移行対象に含まれる", () => {
    expect(EXPORTED_MODEL_NAMES).toContain("DuplicateDismissal");
    expect(EXPORTED_MODEL_NAMES).toContain("Watchlist");
  });
});

describe("内容一致検証（指摘②: diffBundles）", () => {
  it("同一内容なら差分なし（往復一致）", () => {
    const a = emptyBundle();
    a.watchlists = [{ id: "w1", entityName: "テスト", deltaFlag: "unknown" }];
    a.candidates = [{ id: "c1", displayId: "CND-1", title: "候補" }];
    const b = emptyBundle();
    // キー順が違っても正規化で一致する。
    b.watchlists = [{ deltaFlag: "unknown", entityName: "テスト", id: "w1" }];
    b.candidates = [{ title: "候補", id: "c1", displayId: "CND-1" }];
    expect(diffBundles(a, b)).toEqual([]);
  });

  it("件数だけ合って内容がズレる場合を検出する（field）", () => {
    const a = emptyBundle();
    a.candidates = [{ id: "c1", title: "元の値" }];
    const b = emptyBundle();
    b.candidates = [{ id: "c1", title: "ズレた値" }];
    const diffs = diffBundles(a, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ table: "candidates", kind: "field" });
  });

  it("取り込み先に存在しない行を検出する（missing）", () => {
    const a = emptyBundle();
    a.watchlists = [
      { id: "w1", entityName: "A" },
      { id: "w2", entityName: "B" },
    ];
    const b = emptyBundle();
    b.watchlists = [{ id: "w1", entityName: "A" }];
    const diffs = diffBundles(a, b);
    expect(diffs).toEqual([
      { table: "watchlists", kind: "count", detail: expect.stringContaining("件数差") },
      { table: "watchlists", kind: "missing", detail: expect.stringContaining("w2") },
    ]);
  });

  it("取り込み先に余分な行を検出する（extra）", () => {
    const a = emptyBundle();
    a.duplicateDismissals = [{ id: "d1", pairKey: "x" }];
    const b = emptyBundle();
    b.duplicateDismissals = [
      { id: "d1", pairKey: "x" },
      { id: "d2", pairKey: "y" },
    ];
    const diffs = diffBundles(a, b);
    expect(diffs.some((d) => d.kind === "extra" && d.detail.includes("d2"))).toBe(true);
  });
});
