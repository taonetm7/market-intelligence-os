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
// 採番は tx.rawSignal.findFirst / tx.candidate.findFirst（最大値1件）に依存する。
// ここでは findFirst をモックした最小の TransactionClient を注入して純粋に検証する。

/**
 * findFirst だけを差し替えた最小の TransactionClient を組み立てる。
 * `latest` は「その接頭辞で既に存在する連番最大の displayId」（無ければ null）。
 */
function fakeTx(latest: { rawSignal?: string | null; candidate?: string | null }) {
  const rawSignalFindFirst = vi
    .fn()
    .mockResolvedValue(latest.rawSignal ? { displayId: latest.rawSignal } : null);
  const candidateFindFirst = vi
    .fn()
    .mockResolvedValue(latest.candidate ? { displayId: latest.candidate } : null);
  const tx = {
    rawSignal: { findFirst: rawSignalFindFirst },
    candidate: { findFirst: candidateFindFirst },
  } as unknown as DisplayIdClient;
  return { tx, rawSignalFindFirst, candidateFindFirst };
}

// テストはローカル日付成分で構築する（CI のタイムゾーンに依存しない決定論性）。
const JUNE_11_2026 = new Date(2026, 5, 11); // 2026-06-11（getMonth は 0 始まり）

describe("nextRawSignalDisplayId", () => {
  it("starts the day at 001 with an 8-digit date when none exists", async () => {
    const { tx } = fakeTx({ rawSignal: null });
    expect(await nextRawSignalDisplayId(tx, JUNE_11_2026)).toBe("RS-20260611-001");
  });

  it("increments the day's max sequence by 1 (zero-padded to 3 digits)", async () => {
    const { tx } = fakeTx({ rawSignal: "RS-20260611-006" });
    expect(await nextRawSignalDisplayId(tx, JUNE_11_2026)).toBe("RS-20260611-007");
  });

  it("rolls the 3-digit padding correctly across the ten/hundred boundary", async () => {
    expect(
      await nextRawSignalDisplayId(fakeTx({ rawSignal: "RS-20260611-009" }).tx, JUNE_11_2026),
    ).toBe("RS-20260611-010");
    expect(
      await nextRawSignalDisplayId(fakeTx({ rawSignal: "RS-20260611-099" }).tx, JUNE_11_2026),
    ).toBe("RS-20260611-100");
  });

  it("resets the sequence per injected day (deterministic by `now`)", async () => {
    // 別日を注入すると、その日にはまだ採番が無い → 001 から。日付セグメントも変わる。
    const { tx } = fakeTx({ rawSignal: null });
    expect(await nextRawSignalDisplayId(tx, new Date(2026, 0, 1))).toBe("RS-20260101-001");
    expect(await nextRawSignalDisplayId(tx, new Date(2026, 11, 31))).toBe("RS-20261231-001");
  });

  it("queries the day's prefix ordered by the latest sequence", async () => {
    const { tx, rawSignalFindFirst } = fakeTx({ rawSignal: "RS-20260611-006" });
    await nextRawSignalDisplayId(tx, JUNE_11_2026);
    expect(rawSignalFindFirst).toHaveBeenCalledWith({
      where: { displayId: { startsWith: "RS-20260611-" } },
      orderBy: { displayId: "desc" },
      select: { displayId: true },
    });
  });

  it("is deterministic for the same client and injected date", async () => {
    const { tx } = fakeTx({ rawSignal: "RS-20260611-041" });
    const first = await nextRawSignalDisplayId(tx, JUNE_11_2026);
    const second = await nextRawSignalDisplayId(tx, JUNE_11_2026);
    expect(first).toBe("RS-20260611-042");
    expect(second).toBe(first);
  });

  it("throws when an existing displayId has a malformed sequence", async () => {
    const { tx } = fakeTx({ rawSignal: "RS-20260611-XYZ" });
    await expect(nextRawSignalDisplayId(tx, JUNE_11_2026)).rejects.toThrow(/連番を解釈できません/);
  });
});

describe("nextCandidateDisplayId", () => {
  it("starts the global sequence at 001 when none exists", async () => {
    const { tx } = fakeTx({ candidate: null });
    expect(await nextCandidateDisplayId(tx)).toBe("CND-001");
  });

  it("increments the global max sequence by 1 (zero-padded to 3 digits)", async () => {
    const { tx } = fakeTx({ candidate: "CND-041" });
    expect(await nextCandidateDisplayId(tx)).toBe("CND-042");
  });

  it("does not depend on the date (single global running number)", async () => {
    const { tx, candidateFindFirst } = fakeTx({ candidate: "CND-099" });
    expect(await nextCandidateDisplayId(tx)).toBe("CND-100");
    expect(candidateFindFirst).toHaveBeenCalledWith({
      where: { displayId: { startsWith: "CND-" } },
      orderBy: { displayId: "desc" },
      select: { displayId: true },
    });
  });

  it("throws when an existing displayId has a malformed sequence", async () => {
    const { tx } = fakeTx({ candidate: "CND-oops" });
    await expect(nextCandidateDisplayId(tx)).rejects.toThrow(/連番を解釈できません/);
  });
});
