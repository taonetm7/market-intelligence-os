import { describe, expect, it, vi } from "vitest";

import {
  type DisplayIdClient,
  nextCandidateDisplayId,
  nextRawSignalDisplayId,
} from "../../lib/db/displayId";

// task-07 acceptance criteria (spec v2 §7.2 / §7.3):
// - 連番フォーマット（ゼロ埋め3桁・日付8桁）: RS-YYYYMMDD-001 / CND-001
// - 既存最大からの +1 採番（モック tx で検証）
// - 日付注入で決定論的にテストできる（now: Date 引数）
// - displayId は表示専用。PK（cuid）には触れない
//
// 採番は tx.rawSignal.findMany / tx.candidate.findMany（接頭辞一致の全件）に依存し、
// 連番を数値パースして最大を求める（辞書順ソート非依存。1000 以上でも正しい）。
// ここでは findMany をモックした最小の TransactionClient を注入して純粋に検証する。

/**
 * findMany だけを差し替えた最小の TransactionClient を組み立てる。
 * 各値は「その接頭辞で既に存在する displayId の一覧」（順不同で良い／無ければ空）。
 */
function fakeTx(existing: { rawSignal?: string[]; candidate?: string[] }) {
  const toRows = (ids?: string[]) => (ids ?? []).map((displayId) => ({ displayId }));
  const rawSignalFindMany = vi.fn().mockResolvedValue(toRows(existing.rawSignal));
  const candidateFindMany = vi.fn().mockResolvedValue(toRows(existing.candidate));
  const tx = {
    rawSignal: { findMany: rawSignalFindMany },
    candidate: { findMany: candidateFindMany },
  } as unknown as DisplayIdClient;
  return { tx, rawSignalFindMany, candidateFindMany };
}

// テストはローカル日付成分で構築する（CI のタイムゾーンに依存しない決定論性）。
const JUNE_11_2026 = new Date(2026, 5, 11); // 2026-06-11（getMonth は 0 始まり）

describe("nextRawSignalDisplayId", () => {
  it("starts the day at 001 with an 8-digit date when none exists", async () => {
    const { tx } = fakeTx({ rawSignal: [] });
    expect(await nextRawSignalDisplayId(tx, JUNE_11_2026)).toBe("RS-20260611-001");
  });

  it("increments the day's max sequence by 1 (zero-padded to 3 digits)", async () => {
    const { tx } = fakeTx({ rawSignal: ["RS-20260611-006"] });
    expect(await nextRawSignalDisplayId(tx, JUNE_11_2026)).toBe("RS-20260611-007");
  });

  it("takes the numeric max regardless of row order (not lexical order)", async () => {
    // 行の到着順に依存せず、数値最大（006）の +1 を返す。
    const { tx } = fakeTx({
      rawSignal: ["RS-20260611-004", "RS-20260611-006", "RS-20260611-001"],
    });
    expect(await nextRawSignalDisplayId(tx, JUNE_11_2026)).toBe("RS-20260611-007");
  });

  it("rolls the 3-digit padding correctly across the ten/hundred boundary", async () => {
    expect(
      await nextRawSignalDisplayId(fakeTx({ rawSignal: ["RS-20260611-009"] }).tx, JUNE_11_2026),
    ).toBe("RS-20260611-010");
    expect(
      await nextRawSignalDisplayId(fakeTx({ rawSignal: ["RS-20260611-099"] }).tx, JUNE_11_2026),
    ).toBe("RS-20260611-100");
  });

  it("does not misjudge the max once the sequence exceeds 999 (Codex regression)", async () => {
    // "RS-...-999" は辞書順では "RS-...-1000" より大きい。数値で最大を取らないと
    // 999 を最大と誤判定し RS-...-1000 を重複発番する。数値最大なら 1000 → 1001。
    const { tx } = fakeTx({
      rawSignal: ["RS-20260611-999", "RS-20260611-1000"],
    });
    expect(await nextRawSignalDisplayId(tx, JUNE_11_2026)).toBe("RS-20260611-1001");
  });

  it("extends the width naturally when crossing 999 → 1000", async () => {
    // 桁あふれ時はゼロ埋め幅（3）を超えて自然に伸長する仕様。
    const { tx } = fakeTx({ rawSignal: ["RS-20260611-999"] });
    expect(await nextRawSignalDisplayId(tx, JUNE_11_2026)).toBe("RS-20260611-1000");
  });

  it("resets the sequence per injected day (deterministic by `now`)", async () => {
    // 別日を注入すると、その日にはまだ採番が無い → 001 から。日付セグメントも変わる。
    const { tx } = fakeTx({ rawSignal: [] });
    expect(await nextRawSignalDisplayId(tx, new Date(2026, 0, 1))).toBe("RS-20260101-001");
    expect(await nextRawSignalDisplayId(tx, new Date(2026, 11, 31))).toBe("RS-20261231-001");
  });

  it("queries only the day's prefix, selecting just displayId", async () => {
    const { tx, rawSignalFindMany } = fakeTx({ rawSignal: ["RS-20260611-006"] });
    await nextRawSignalDisplayId(tx, JUNE_11_2026);
    expect(rawSignalFindMany).toHaveBeenCalledWith({
      where: { displayId: { startsWith: "RS-20260611-" } },
      select: { displayId: true },
    });
  });

  it("is deterministic for the same client and injected date", async () => {
    const { tx } = fakeTx({ rawSignal: ["RS-20260611-041"] });
    const first = await nextRawSignalDisplayId(tx, JUNE_11_2026);
    const second = await nextRawSignalDisplayId(tx, JUNE_11_2026);
    expect(first).toBe("RS-20260611-042");
    expect(second).toBe(first);
  });

  it("throws when an existing displayId has a malformed sequence", async () => {
    const { tx } = fakeTx({ rawSignal: ["RS-20260611-XYZ"] });
    await expect(nextRawSignalDisplayId(tx, JUNE_11_2026)).rejects.toThrow(/連番を解釈できません/);
  });
});

describe("nextCandidateDisplayId", () => {
  it("starts the global sequence at 001 when none exists", async () => {
    const { tx } = fakeTx({ candidate: [] });
    expect(await nextCandidateDisplayId(tx)).toBe("CND-001");
  });

  it("increments the global max sequence by 1 (zero-padded to 3 digits)", async () => {
    const { tx } = fakeTx({ candidate: ["CND-041"] });
    expect(await nextCandidateDisplayId(tx)).toBe("CND-042");
  });

  it("takes the numeric max regardless of row order", async () => {
    const { tx } = fakeTx({ candidate: ["CND-002", "CND-041", "CND-017"] });
    expect(await nextCandidateDisplayId(tx)).toBe("CND-042");
  });

  it("does not misjudge the max once the sequence exceeds 999 (Codex regression)", async () => {
    // 既存に CND-1000 がある状態で CND-999 を最大扱いすると CND-1000 を重複発番する。
    // 数値最大なら 1000 → 1001。
    const { tx } = fakeTx({ candidate: ["CND-999", "CND-1000"] });
    expect(await nextCandidateDisplayId(tx)).toBe("CND-1001");
  });

  it("extends the width naturally when crossing 999 → 1000", async () => {
    const { tx } = fakeTx({ candidate: ["CND-999"] });
    expect(await nextCandidateDisplayId(tx)).toBe("CND-1000");
  });

  it("does not depend on the date (single global running number)", async () => {
    const { tx, candidateFindMany } = fakeTx({ candidate: ["CND-099"] });
    expect(await nextCandidateDisplayId(tx)).toBe("CND-100");
    expect(candidateFindMany).toHaveBeenCalledWith({
      where: { displayId: { startsWith: "CND-" } },
      select: { displayId: true },
    });
  });

  it("throws when an existing displayId has a malformed sequence", async () => {
    const { tx } = fakeTx({ candidate: ["CND-oops"] });
    await expect(nextCandidateDisplayId(tx)).rejects.toThrow(/連番を解釈できません/);
  });
});
