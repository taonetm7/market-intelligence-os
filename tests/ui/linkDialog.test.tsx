import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DEFAULT_CREDIBILITY,
  EVIDENCE_TYPE_OPTIONS,
  LinkDialog,
  buildLinkParams,
  createLatestGuard,
  filterCandidates,
  searchCandidates,
  searchUnlinkedRawSignals,
  submitLink,
  unlinkedRawSignalsUrl,
  type CandidateOption,
} from "../../components/evidence/LinkDialog";
import { EVIDENCE_TYPE_VALUES } from "../../lib/validation/enums";

// task-22 Evidence link UI（spec v2 §9.6）。
// テスト基盤に DOM/インタラクション依存は足さない方針のため、検索（fetcher DI）・送信・
// パラメータ組立などのロジックを純関数として駆動して受入基準を検証し、描画は react-dom/server
// の静的描画で確認する。テストの import は相対パス（@/ エイリアスは vitest 非対応）。

// ---------------------------------------------------------------------------
// 状態を持つ擬似 API
// 候補一覧 / 未紐付け RawSignal 検索 / link（重複は 409）を一通り扱い、「両導線で link が成立し
// Evidence が増える」「二重 link は 409」「link 後に distinctSources が増える」を E2E 的に検証する。
// ---------------------------------------------------------------------------

type Cand = { id: string; displayId: string; title: string; problemFamily: string | null };
type Raw = {
  id: string;
  displayId: string;
  sourceType: string;
  rawText: string;
  observedEntity: string | null;
  status: string;
};
type Ev = {
  id: string;
  candidateId: string;
  rawSignalId: string;
  evidenceType: string;
  strength: number;
  credibility: number;
};

function makeFakeApi(seed: { candidates: Cand[]; rawSignals: Raw[] }) {
  const candidates = seed.candidates.map((c) => ({ ...c }));
  const rawSignals = seed.rawSignals.map((r) => ({ ...r }));
  const evidence: Ev[] = [];
  const linkedRawIds = new Set<string>();
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let evSeq = 0;

  /** 候補に紐付く Evidence の RawSignal.sourceType 異なり数（§9.4 distinctSources / §8.2）。 */
  function distinctSourceTypes(candidateId: string): number {
    const types = evidence
      .filter((e) => e.candidateId === candidateId)
      .map((e) => rawSignals.find((r) => r.id === e.rawSignalId)?.sourceType);
    return new Set(types).size;
  }

  const fetcher = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    // 候補一覧（导线A の検索元。q 非対応＝全件返し、絞り込みは client 側 filterCandidates）。
    if (url === "/api/candidates" && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ data: candidates }) } as unknown as Response;
    }

    // 未紐付け RawSignal 検索（导线B）。unlinked=1（inbox かつ未 link）＋ q で rawText/observedEntity を絞る。
    if (url.startsWith("/api/raw-signals?") && method === "GET") {
      const q = new URL(`http://x${url}`).searchParams.get("q")?.toLowerCase() ?? "";
      const data = rawSignals.filter((r) => {
        if (r.status !== "inbox" || linkedRawIds.has(r.id)) return false;
        if (q === "") return true;
        return (
          r.rawText.toLowerCase().includes(q) ||
          (r.observedEntity ?? "").toLowerCase().includes(q)
        );
      });
      return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
    }

    // link（POST）。同一 (candidate, raw, type) は 409。成功は 201 で { evidence, stats }。
    const linkMatch = /^\/api\/raw-signals\/([^/]+)\/link-candidate$/.exec(url);
    if (linkMatch && method === "POST") {
      const rawSignalId = linkMatch[1];
      const { candidateId, evidenceType, strength, credibility } = body as {
        candidateId: string;
        evidenceType: string;
        strength: number;
        credibility: number;
      };
      const dup = evidence.some(
        (e) =>
          e.candidateId === candidateId &&
          e.rawSignalId === rawSignalId &&
          e.evidenceType === evidenceType,
      );
      if (dup) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: { message: "duplicate" } }),
        } as unknown as Response;
      }
      evSeq += 1;
      evidence.push({ id: `ev-${evSeq}`, candidateId, rawSignalId, evidenceType, strength, credibility });
      linkedRawIds.add(rawSignalId);
      const stats = {
        distinctSourceTypes: distinctSourceTypes(candidateId),
        avgStrength: 0,
        hasDirectSpend: evidence.some((e) => e.candidateId === candidateId && e.evidenceType === "spend"),
        strongSignalTypes: [] as string[],
      };
      return {
        ok: true,
        status: 201,
        json: async () => ({
          data: { evidence: { id: `ev-${evSeq}`, evidenceType, strength, credibility }, stats },
        }),
      } as unknown as Response;
    }

    return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;

  return { candidates, rawSignals, evidence, calls, fetcher, distinctSourceTypes };
}

function seedApi() {
  return makeFakeApi({
    candidates: [
      { id: "c1", displayId: "CND-001", title: "請求書アプリ", problemFamily: "請求・経理" },
      { id: "c2", displayId: "CND-002", title: "在庫管理ツール", problemFamily: "物流" },
    ],
    rawSignals: [
      { id: "r1", displayId: "RS-001", sourceType: "app_store", rawText: "競合が値上げした", observedEntity: "App A", status: "inbox" },
      { id: "r2", displayId: "RS-002", sourceType: "review", rawText: "解約したい", observedEntity: null, status: "inbox" },
    ],
  });
}

// ---------------------------------------------------------------------------
// 連番ガード
// ---------------------------------------------------------------------------

describe("LinkDialog: 連番ガード（stale response 対策）", () => {
  it("最新トークンだけを current とみなす", () => {
    const guard = createLatestGuard();
    const t1 = guard.next();
    const t2 = guard.next();
    expect(guard.isCurrent(t1)).toBe(false);
    expect(guard.isCurrent(t2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enum / 既定値
// ---------------------------------------------------------------------------

describe("LinkDialog: evidenceType セレクト・既定値", () => {
  it("証拠種別の選択肢は enum 値タプル（task-02）から生成する", () => {
    expect(EVIDENCE_TYPE_OPTIONS.map((o) => o.value)).toEqual([...EVIDENCE_TYPE_VALUES]);
  });

  it("credibility の既定は 3（§9.6）", () => {
    expect(DEFAULT_CREDIBILITY).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 导线A: 候補のインクリメンタル検索（client 側 q 絞り込み）
// ---------------------------------------------------------------------------

describe("LinkDialog 导线A: 候補検索（title / problemFamily）", () => {
  it("filterCandidates は title でも problemFamily でも部分一致する（大小無視）", () => {
    const items: CandidateOption[] = [
      { id: "c1", displayId: "CND-001", title: "請求書アプリ", problemFamily: "請求・経理" },
      { id: "c2", displayId: "CND-002", title: "在庫管理ツール", problemFamily: "物流" },
    ];
    expect(filterCandidates(items, "請求").map((c) => c.id)).toEqual(["c1"]);
    expect(filterCandidates(items, "物流").map((c) => c.id)).toEqual(["c2"]);
    // 空 q は全件。
    expect(filterCandidates(items, "  ").map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("searchCandidates は GET /api/candidates を叩き q で絞り込む", async () => {
    const api = seedApi();
    const hit = await searchCandidates("経理", api.fetcher);
    expect(api.calls[0].url).toBe("/api/candidates");
    expect(hit.map((c) => c.id)).toEqual(["c1"]);
  });
});

// ---------------------------------------------------------------------------
// 导线B: 未紐付け RawSignal のサーバ側 q 検索
// ---------------------------------------------------------------------------

describe("LinkDialog 导线B: 未紐付け RawSignal 検索", () => {
  it("unlinkedRawSignalsUrl は unlinked=1 と q を組む（空 q は付けない）", () => {
    expect(unlinkedRawSignalsUrl("")).toBe("/api/raw-signals?unlinked=1");
    expect(unlinkedRawSignalsUrl("値上げ")).toBe("/api/raw-signals?unlinked=1&q=%E5%80%A4%E4%B8%8A%E3%81%92");
  });

  it("searchUnlinkedRawSignals は未紐付けのみ返し q で絞る", async () => {
    const api = seedApi();
    const hit = await searchUnlinkedRawSignals("解約", api.fetcher);
    expect(hit.map((r) => r.id)).toEqual(["r2"]);
  });
});

// ---------------------------------------------------------------------------
// buildLinkParams: 固定エンティティ × 選択相手のマッピング
// ---------------------------------------------------------------------------

describe("LinkDialog: link パラメータ組立（导線で固定/選択が入れ替わる）", () => {
  it("导线A は rawSignalId 固定・candidateId=選択", () => {
    const p = buildLinkParams({
      rawSignalId: "r1",
      selectedId: "c1",
      evidenceType: "spend",
      strength: 4,
      credibility: 3,
    });
    expect(p).toEqual({ rawSignalId: "r1", candidateId: "c1", evidenceType: "spend", strength: 4, credibility: 3 });
  });

  it("导线B は candidateId 固定・rawSignalId=選択", () => {
    const p = buildLinkParams({
      candidateId: "c1",
      selectedId: "r2",
      evidenceType: "dissatisfaction",
      strength: 2,
      credibility: 3,
    });
    expect(p).toEqual({ rawSignalId: "r2", candidateId: "c1", evidenceType: "dissatisfaction", strength: 2, credibility: 3 });
  });
});

// ---------------------------------------------------------------------------
// submitLink: link 成立 / 二重 link 409 / distinctSources 増加
// ---------------------------------------------------------------------------

describe("LinkDialog: link 送信（両導線で成立）", () => {
  it("导线A（RawSignal 起点）で link が成立し Evidence が増える", async () => {
    const api = seedApi();
    const result = await submitLink(
      buildLinkParams({ rawSignalId: "r1", selectedId: "c1", evidenceType: "spend", strength: 4, credibility: 3 }),
      api.fetcher,
    );
    expect(result.evidence.evidenceType).toBe("spend");
    expect(api.evidence).toHaveLength(1);
    expect(api.evidence[0]).toMatchObject({ candidateId: "c1", rawSignalId: "r1", evidenceType: "spend" });
    // link 済みの RawSignal は未紐付け検索から外れる。
    const remaining = await searchUnlinkedRawSignals("", api.fetcher);
    expect(remaining.map((r) => r.id)).toEqual(["r2"]);
  });

  it("导线B（Candidate 起点）で link が成立し Evidence が増える", async () => {
    const api = seedApi();
    const result = await submitLink(
      buildLinkParams({ candidateId: "c1", selectedId: "r2", evidenceType: "dissatisfaction", strength: 3, credibility: 3 }),
      api.fetcher,
    );
    expect(result.evidence.evidenceType).toBe("dissatisfaction");
    expect(api.evidence[0]).toMatchObject({ candidateId: "c1", rawSignalId: "r2" });
  });

  it("link 後に candidate の distinctSources が増える（異なる sourceType を link）", async () => {
    const api = seedApi();
    // r1 = app_store, r2 = review。両方を c1 に link すると distinctSourceTypes が 1 → 2 に増える。
    const first = await submitLink(
      buildLinkParams({ candidateId: "c1", selectedId: "r1", evidenceType: "spend", strength: 4, credibility: 3 }),
      api.fetcher,
    );
    expect(first.stats.distinctSourceTypes).toBe(1);

    const second = await submitLink(
      buildLinkParams({ candidateId: "c1", selectedId: "r2", evidenceType: "dissatisfaction", strength: 3, credibility: 3 }),
      api.fetcher,
    );
    expect(second.stats.distinctSourceTypes).toBe(2);
    expect(api.distinctSourceTypes("c1")).toBe(2);
  });

  it("二重 link（同一 candidate/raw/type）は 409 → エラーメッセージで throw する", async () => {
    const api = seedApi();
    const params = buildLinkParams({
      rawSignalId: "r1",
      selectedId: "c1",
      evidenceType: "spend",
      strength: 4,
      credibility: 3,
    });
    await submitLink(params, api.fetcher); // 1 回目は成立
    await expect(submitLink(params, api.fetcher)).rejects.toThrow(/二重 link/);
    // 重複ぶんは増えていない。
    expect(api.evidence).toHaveLength(1);
  });

  it("!ok（409 以外）は失敗メッセージで throw する", async () => {
    const failing = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(
      submitLink({ rawSignalId: "r1", candidateId: "c1", evidenceType: "spend", strength: 4, credibility: 3 }, failing),
    ).rejects.toThrow(/紐付けに失敗/);
  });
});

// ---------------------------------------------------------------------------
// 描画スモーク（react-dom/server）
// ---------------------------------------------------------------------------

describe("LinkDialog: 描画スモーク", () => {
  it("导线A（RawSignal 起点）は候補検索＋証拠種別セレクトを描画する", () => {
    const html = renderToStaticMarkup(
      <LinkDialog
        open
        onClose={() => {}}
        rawSignalId="r1"
        rawSignalLabel="RS-001"
        onLinked={() => {}}
      />,
    );
    expect(html).toContain("Evidence を link");
    expect(html).toContain("RS-001");
    expect(html).toContain("を候補に link します");
    expect(html).toContain("候補を検索");
    expect(html).toContain("証拠種別");
    expect(html).toContain('value="spend"'); // enum セレクト
    expect(html).toContain("link する");
  });

  it("导线B（Candidate 起点）は未紐付け Raw Signal 検索を描画する", () => {
    const html = renderToStaticMarkup(
      <LinkDialog
        open
        onClose={() => {}}
        candidateId="c1"
        candidateLabel="CND-001"
        onLinked={() => {}}
      />,
    );
    expect(html).toContain("CND-001");
    expect(html).toContain("に Raw Signal を link します");
    expect(html).toContain("未紐付け Raw Signal を検索");
  });

  it("closed では何も描画しない", () => {
    const html = renderToStaticMarkup(
      <LinkDialog open={false} onClose={() => {}} candidateId="c1" onLinked={() => {}} />,
    );
    expect(html).toBe("");
  });
});
