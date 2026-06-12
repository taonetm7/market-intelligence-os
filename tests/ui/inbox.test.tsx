import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TriageQueue,
  INBOX_QUEUE_URL,
  PROMOTE_EVIDENCE_TYPE,
  PROMOTE_STRENGTH,
  archiveSignal,
  buildCandidateTitleFromSignal,
  fetchInboxQueue,
  ignoreSignal,
  promoteToCandidate,
} from "../../components/inbox/TriageQueue";
import {
  TriageRow,
  formatObservedEntity,
  truncate,
  type TriageSignal,
} from "../../components/inbox/TriageRow";
import { createLatestGuard } from "../../app/inbox/page";

// task-18 Inbox Triage（spec v2 §9.1 既定ランディング）。
// テスト基盤に DOM/インタラクション依存は足さない方針のため、取得（fetcher DI）・
// トリアージ操作（status 変更 / 新規候補化）・タイトル導出などのロジックを純関数として
// 駆動して受入基準を検証し、描画は react-dom/server の静的描画で確認する。

/** トリアージ 1 件のダミー。 */
function signal(overrides: Partial<TriageSignal> = {}): TriageSignal {
  return {
    id: "rs1",
    displayId: "RS-20260612-001",
    sourceType: "app_store",
    sourceUrl: "https://example.com/app",
    rawText: "競合アプリが値上げした",
    observedEntity: "Example App",
    status: "inbox",
    ...overrides,
  };
}

/**
 * 状態を持つ擬似 API。未紐付けキュー取得・status 変更・候補作成・link を一通り扱い、
 * 「処理済みはキューから外れる」「新規候補化で即 link される」を E2E 的に検証できる。
 * store の各行は status と linked（Evidence 有無）を持ち、unlinked=1 は inbox かつ未 link のみ返す。
 */
function makeFakeApi(initial: TriageSignal[]) {
  const store: TriageSignal[] = initial.map((s) => ({ ...s }));
  // link 済み（Evidence 1 件以上）の id。unlinked=1 はこれらを未処理から除外する。
  const linkedIds = new Set<string>();
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let candidateSeq = 0;

  const fetcher = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    // 未処理キュー: inbox かつ未 link のみ（repository の unlinked=1 と同じ意味）。
    if (url === INBOX_QUEUE_URL && method === "GET") {
      const data = store.filter((s) => s.status === "inbox" && !linkedIds.has(s.id));
      return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
    }

    // status 変更（Ignore / Archive）。
    const putMatch = /^\/api\/raw-signals\/([^/]+)$/.exec(url);
    if (putMatch && method === "PUT") {
      const target = store.find((s) => s.id === putMatch[1]);
      if (!target) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      target.status = (body as { status: string }).status;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { id: target.id, status: target.status } }),
      } as unknown as Response;
    }

    // 新規候補化 1) Candidate 作成。
    if (url === "/api/candidates" && method === "POST") {
      candidateSeq += 1;
      const id = `cand-${candidateSeq}`;
      return {
        ok: true,
        status: 201,
        json: async () => ({ data: { id, displayId: `C-${candidateSeq}`, ...body } }),
      } as unknown as Response;
    }

    // 新規候補化 2) 即 link（Evidence 付与 → 未紐付けから外れる）。
    const linkMatch = /^\/api\/raw-signals\/([^/]+)\/link-candidate$/.exec(url);
    if (linkMatch && method === "POST") {
      const target = store.find((s) => s.id === linkMatch[1]);
      if (!target) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      linkedIds.add(target.id);
      return {
        ok: true,
        status: 201,
        json: async () => ({ data: { evidence: { id: "ev1", ...body }, stats: {} } }),
      } as unknown as Response;
    }

    return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;

  return { store, calls, fetcher };
}

describe("Inbox: 連番ガード（stale response 対策）", () => {
  it("最新トークンだけを current とみなす", () => {
    const guard = createLatestGuard();
    const t1 = guard.next();
    const t2 = guard.next();
    expect(guard.isCurrent(t1)).toBe(false);
    expect(guard.isCurrent(t2)).toBe(true);
  });
});

describe("Inbox: キュー取得", () => {
  it("未紐付けキューは GET /api/raw-signals?unlinked=1 を使う", () => {
    expect(INBOX_QUEUE_URL).toBe("/api/raw-signals?unlinked=1");
  });

  it("fetchInboxQueue は unlinked=1 を叩き、未処理（inbox かつ未 link）だけ返す", async () => {
    const { calls, fetcher } = makeFakeApi([
      signal({ id: "rs1" }),
      signal({ id: "rs2", displayId: "RS-20260612-002", status: "archived" }),
    ]);
    const rows = await fetchInboxQueue(fetcher);
    expect(calls[0].url).toBe("/api/raw-signals?unlinked=1");
    // archived は未処理ではない（キューに出ない）。
    expect(rows.map((r) => r.id)).toEqual(["rs1"]);
  });

  it("取得失敗（!ok）は throw する", async () => {
    const failing = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchInboxQueue(failing)).rejects.toThrow();
  });
});

describe("Inbox: Ignore / Archive で status が変わりキューから外れる", () => {
  it("Ignore すると status=ignored になり、次の取得でキューから消える", async () => {
    const { store, calls, fetcher } = makeFakeApi([signal({ id: "rs1" })]);

    await ignoreSignal("rs1", fetcher);
    expect(store[0].status).toBe("ignored");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/raw-signals/rs1");
    expect(put?.body).toEqual({ status: "ignored" });

    // 再取得でキューから外れる。
    const rows = await fetchInboxQueue(fetcher);
    expect(rows).toHaveLength(0);
  });

  it("Archive すると status=archived になり、次の取得でキューから消える", async () => {
    const { store, fetcher } = makeFakeApi([signal({ id: "rs1" })]);
    await archiveSignal("rs1", fetcher);
    expect(store[0].status).toBe("archived");
    const rows = await fetchInboxQueue(fetcher);
    expect(rows).toHaveLength(0);
  });

  it("status 更新失敗（!ok）は throw する", async () => {
    const failing = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(ignoreSignal("rs1", failing)).rejects.toThrow();
  });
});

describe("Inbox: 新規候補化（Candidate 作成 → 即 link）", () => {
  it("候補タイトルは観測対象を優先し、無ければ観測本文の先頭を使う", () => {
    expect(buildCandidateTitleFromSignal(signal({ observedEntity: "Example App" }))).toBe(
      "Example App",
    );
    expect(
      buildCandidateTitleFromSignal(signal({ observedEntity: null, rawText: "値上げの兆候" })),
    ).toBe("値上げの兆候");
  });

  it("POST /api/candidates → POST link-candidate の順で呼び、即 link でキューから外れる", async () => {
    const { calls, fetcher } = makeFakeApi([signal({ id: "rs1" })]);

    const result = await promoteToCandidate(signal({ id: "rs1" }), fetcher);
    expect(result.candidate.id).toBe("cand-1");

    // 1) 候補作成: title を渡し、stage は送らない（送ると API が 400）。
    const create = calls.find((c) => c.url === "/api/candidates");
    expect(create?.method).toBe("POST");
    expect(create?.body).toEqual({ title: "Example App" });
    expect((create?.body as Record<string, unknown>).stage).toBeUndefined();

    // 2) 即 link: 作成した candidateId と既定 type/strength。
    const link = calls.find((c) => c.url === "/api/raw-signals/rs1/link-candidate");
    expect(link?.method).toBe("POST");
    expect(link?.body).toEqual({
      candidateId: "cand-1",
      evidenceType: PROMOTE_EVIDENCE_TYPE,
      strength: PROMOTE_STRENGTH,
    });

    // link 済みなのでキューから外れる。
    const rows = await fetchInboxQueue(fetcher);
    expect(rows).toHaveLength(0);
  });

  it("初期 link の strength は最小（過大評価を避ける・§9.5）", () => {
    expect(PROMOTE_STRENGTH).toBe(1);
  });

  it("候補作成に失敗したら link を呼ばずに throw する", async () => {
    const calls: string[] = [];
    const failing = (async (url: string) => {
      calls.push(url);
      if (url === "/api/candidates") {
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, status: 201, json: async () => ({ data: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(promoteToCandidate(signal(), failing)).rejects.toThrow();
    // link-candidate は呼ばれない。
    expect(calls.some((u) => u.includes("link-candidate"))).toBe(false);
  });
});

describe("Inbox: 整形ヘルパ", () => {
  it("truncate は max 超で末尾を省略する", () => {
    expect(truncate("a".repeat(130))).toHaveLength(121); // 120 + "…"
    expect(truncate("短い")).toBe("短い");
  });

  it("formatObservedEntity は空を — にする", () => {
    expect(formatObservedEntity(null)).toBe("—");
    expect(formatObservedEntity("  ")).toBe("—");
    expect(formatObservedEntity("App")).toBe("App");
  });
});

describe("Inbox: 描画スモーク", () => {
  it("TriageRow は観測事実・sourceType・URL と 4 操作ボタンを描画する", () => {
    const html = renderToStaticMarkup(
      <TriageRow
        signal={signal()}
        onLink={() => {}}
        onPromote={() => {}}
        onIgnore={() => {}}
        onArchive={() => {}}
      />,
    );
    expect(html).toContain("競合アプリが値上げした");
    expect(html).toContain("app_store");
    expect(html).toContain("https://example.com/app");
    expect(html).toContain("Link");
    expect(html).toContain("新規候補化");
    expect(html).toContain("Ignore");
    expect(html).toContain("Archive");
  });

  it("TriageQueue は空のとき未処理なしを表示する", () => {
    const html = renderToStaticMarkup(
      <TriageQueue
        signals={[]}
        onLink={() => {}}
        onPromote={() => {}}
        onIgnore={() => {}}
        onArchive={() => {}}
      />,
    );
    expect(html).toContain("未処理の Raw Signal はありません");
  });

  it("TriageQueue は各 Signal を 1 行として並べる", () => {
    const html = renderToStaticMarkup(
      <TriageQueue
        signals={[signal({ id: "rs1" }), signal({ id: "rs2", displayId: "RS-20260612-002" })]}
        onLink={() => {}}
        onPromote={() => {}}
        onIgnore={() => {}}
        onArchive={() => {}}
      />,
    );
    expect(html).toContain("RS-20260612-001");
    expect(html).toContain("RS-20260612-002");
  });
});
