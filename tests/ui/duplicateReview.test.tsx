import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DUPLICATES_ENDPOINT,
  buildDuplicatesUrl,
  fetchDuplicatePairs,
} from "../../app/duplicates/page";
import {
  COMPARISON_FIELDS,
  DISMISS_ENDPOINT,
  DuplicatePairCard,
  FEATURE_LABELS,
  MergeConfirmDialog,
  SplitConfirmDialog,
  canAct,
  defaultMergeReason,
  defaultSplitReason,
  formatScorePct,
  matchedFieldSet,
  pairKey,
  resolveMergeIds,
  submitDismiss,
  type DuplicateCandidateView,
  type DuplicatePairView,
} from "../../components/duplicate/DuplicatePairCard";
import {
  mergeEndpoint,
  splitEndpoint,
  submitMerge,
  submitSplit,
} from "../../components/candidate/MergeSplitDialog";
import { stageSchema } from "../../lib/validation/enums";

// 注: lib/db/duplicateDismissalRepo は top-level で import しない。
// 同モジュールは client シングルトンを引くため、ここで読むと DB 統合テストの beforeAll で
// DATABASE_URL を temp DB に向ける前にシングルトンが確定してしまう（既存 tests/api と同じ事情）。
// normalizePairKey の規約（無向・client pairKey と一致）は下の実 DB 除外テストで担保する。

// task-35 — Duplicate Review UI（spec v2 §9.7）。
// 純関数（fetcher DI）・確認導線・抑制 API 委譲は静的描画 / node で駆動し、抑制の永続化と
// 「一覧取得時に抑制済みペアが除外され再取得でも復活しない」（Phase 2 / Codex 指摘2）は専用
// SQLite に向けた実 route の往復で検証する。import は相対パス（@/ は vitest 非対応）。

function candidate(overrides: Partial<DuplicateCandidateView> = {}): DuplicateCandidateView {
  return {
    id: "c-a",
    displayId: "CND-001",
    title: "請求書作成アプリ",
    problemFamily: "請求書の作成と送付",
    targetUser: "個人事業主",
    contextTrigger: "月末の締め作業",
    painStatement: "毎月手作業で請求書を作るのが面倒",
    currentSubstitute: "Excel テンプレート",
    stage: stageSchema.enum.normalized,
    ...overrides,
  };
}

function pairFixture(overrides: Partial<DuplicatePairView> = {}): DuplicatePairView {
  return {
    a: candidate({ id: "c-a", displayId: "CND-001", title: "請求書作成アプリ" }),
    b: candidate({ id: "c-b", displayId: "CND-002", title: "インボイス自動化" }),
    score: 0.8,
    matched: [
      { field: "problemFamily", similarity: 1 },
      { field: "painStatement", similarity: 0.7 },
    ],
    ...overrides,
  };
}

/** 一覧 API を受ける擬似 fetch。呼ばれた URL を記録する。 */
function makeListApi(data: DuplicatePairView[]) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

/** merge / split / dismiss を受ける擬似 fetch。URL と body を記録し ok を返す。 */
function recordingApi() {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, status: 200, json: async () => ({ data: { ok: true } }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe("buildDuplicatesUrl / fetchDuplicatePairs: 取得経路", () => {
  it("クエリ無しは素のエンドポイント", () => {
    expect(buildDuplicatesUrl()).toBe(DUPLICATES_ENDPOINT);
  });

  it("threshold / limit をクエリへマップする", () => {
    const url = buildDuplicatesUrl({ threshold: 0.6, limit: 5 });
    const params = new URL(url, "http://x").searchParams;
    expect(params.get("threshold")).toBe("0.6");
    expect(params.get("limit")).toBe("5");
  });

  it("エンドポイントで取得し data を返す（fetcher DI）", async () => {
    const { calls, fetcher } = makeListApi([pairFixture()]);
    const result = await fetchDuplicatePairs({}, fetcher);
    expect(calls[0]).toBe(DUPLICATES_ENDPOINT);
    expect(result).toHaveLength(1);
    expect(result[0].a.displayId).toBe("CND-001");
  });

  it("!ok なら例外を投げる", async () => {
    const failing = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchDuplicatePairs({}, failing)).rejects.toThrow();
  });
});

describe("pairKey: 無向ペアの安定キー", () => {
  it("pairKey は左右の順序に依らない（同じ 2 候補は同じキー）", () => {
    const ab = pairFixture();
    const ba = pairFixture({ a: ab.b, b: ab.a });
    expect(pairKey(ab)).toBe(pairKey(ba));
  });
});

describe("一致理由・survivor 解決・整形・選択ガード", () => {
  it("matchedFieldSet は一致した素性キーの集合", () => {
    const set = matchedFieldSet(pairFixture().matched);
    expect(set.has("problemFamily")).toBe(true);
    expect(set.has("painStatement")).toBe(true);
    expect(set.has("targetUser")).toBe(false);
  });

  it("formatScorePct は百分率整数表記", () => {
    expect(formatScorePct(0.8)).toBe("80%");
    expect(formatScorePct(1)).toBe("100%");
  });

  it("canAct は survivor 未選択（null）で false・選択済みで true（Merge/Split のガード）", () => {
    expect(canAct(null)).toBe(false);
    expect(canAct("a")).toBe(true);
    expect(canAct("b")).toBe(true);
  });

  it("resolveMergeIds は survivor 側の選択で生存 / 吸収 ID を入れ替える", () => {
    const pair = pairFixture();
    expect(resolveMergeIds(pair, "a")).toEqual({ survivorId: "c-a", absorbedId: "c-b" });
    expect(resolveMergeIds(pair, "b")).toEqual({ survivorId: "c-b", absorbedId: "c-a" });
  });

  it("既定理由は非空で displayId を含む（API の必須を満たす）", () => {
    const pair = pairFixture();
    const reason = defaultMergeReason(pair.a, pair.b);
    expect(reason).toContain("CND-001");
    expect(reason).toContain("CND-002");
    expect(defaultSplitReason(pair.a).length).toBeGreaterThan(0);
  });

  it("COMPARISON_FIELDS は §9.7 のテキスト 5 項目（tags は含めない）", () => {
    expect(COMPARISON_FIELDS.map((f) => f.key)).toEqual([
      "problemFamily",
      "painStatement",
      "targetUser",
      "contextTrigger",
      "currentSubstitute",
    ]);
    expect(FEATURE_LABELS.tags).toBeDefined();
  });
});

describe("Merge / Split / 抑制は API 経由で実行される（fetcher DI）", () => {
  it("submitMerge は survivor の merge エンドポイントへ absorbedId / reason を POST", async () => {
    const pair = pairFixture();
    const { survivorId, absorbedId } = resolveMergeIds(pair, "a");
    const { calls, fetcher } = recordingApi();
    await submitMerge(survivorId, { absorbedId, reason: defaultMergeReason(pair.a, pair.b) }, fetcher);
    expect(calls[0].url).toBe(mergeEndpoint("c-a"));
    expect(calls[0].body).toMatchObject({ absorbedId: "c-b" });
    expect((calls[0].body as { reason: string }).reason.length).toBeGreaterThan(0);
  });

  it("submitSplit は対象候補の split エンドポイントへ reason を POST", async () => {
    const pair = pairFixture();
    const { calls, fetcher } = recordingApi();
    await submitSplit(pair.a.id, { evidenceIds: [], reason: defaultSplitReason(pair.a) }, fetcher);
    expect(calls[0].url).toBe(splitEndpoint("c-a"));
    expect((calls[0].body as { reason: string }).reason.length).toBeGreaterThan(0);
  });

  it("submitDismiss は抑制エンドポイントへ 2 候補 ID と kind を POST（永続化要求）", async () => {
    const pair = pairFixture();
    const { calls, fetcher } = recordingApi();
    await submitDismiss(pair, "keep_separate", fetcher);
    expect(calls[0].url).toBe(DISMISS_ENDPOINT);
    expect(calls[0].body).toMatchObject({
      candidateAId: "c-a",
      candidateBId: "c-b",
      kind: "keep_separate",
    });
  });

  it("submitDismiss は !ok で例外", async () => {
    const failing = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(submitDismiss(pairFixture(), "not_duplicate", failing)).rejects.toThrow();
  });
});

describe("確認ダイアログ（Merge/Split 即時実行しない・取消可能＝Phase2 指摘1）", () => {
  it("MergeConfirmDialog は survivor/absorbed と キャンセル/統合する を出す", () => {
    const pair = pairFixture();
    const html = renderToStaticMarkup(
      <MergeConfirmDialog
        open
        survivor={pair.a}
        absorbed={pair.b}
        reason="統合理由"
        onReasonChange={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
        busy={false}
        error={null}
      />,
    );
    expect(html).toContain("統合の確認");
    expect(html).toContain("CND-001");
    expect(html).toContain("CND-002");
    expect(html).toContain("キャンセル");
    expect(html).toContain("統合する");
  });

  it("SplitConfirmDialog は分割元と Evidence 入力・キャンセル/分割する を出す", () => {
    const pair = pairFixture();
    const html = renderToStaticMarkup(
      <SplitConfirmDialog
        open
        source={pair.a}
        reason="分割理由"
        onReasonChange={() => {}}
        evidenceIdsText=""
        onEvidenceIdsChange={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
        busy={false}
        error={null}
      />,
    );
    expect(html).toContain("分割の確認");
    expect(html).toContain("CND-001");
    expect(html).toContain("Evidence ID");
    expect(html).toContain("キャンセル");
    expect(html).toContain("分割する");
  });
});

describe("DuplicatePairCard: 描画（並べて差分＋一致理由＋操作・選択前は実行不可）", () => {
  const html = renderToStaticMarkup(
    <DuplicatePairCard pair={pairFixture()} onResolved={() => {}} />,
  );

  it("2 候補を左右に並べて表示する", () => {
    expect(html).toContain("CND-001");
    expect(html).toContain("請求書作成アプリ");
    expect(html).toContain("CND-002");
    expect(html).toContain("インボイス自動化");
  });

  it("一致理由（matched の項目ラベル）を表示しハイライトする", () => {
    expect(html).toContain("一致理由");
    expect(html).toContain(FEATURE_LABELS.problemFamily);
    expect(html).toContain("mi-dup-match");
  });

  it("4 操作と survivor 選択を出し、未選択では Merge/Split が disabled", () => {
    expect(html).toContain("統合（Merge）");
    expect(html).toContain("分割（Split）");
    expect(html).toContain("別物として残す（Keep Separate）");
    expect(html).toContain("重複でない（Not Duplicate）");
    expect(html).toContain('type="radio"');
    // survivor 未選択の初期状態では実行不可（ガード）。
    expect(html).toContain("対象候補の選択が必要です");
    expect(html).toContain("disabled");
  });

  it("類似度スコアを百分率で表示する", () => {
    expect(html).toContain("80%");
  });
});

// --- 実 DB 統合: 抑制の永続化と一覧除外（再取得でも復活しない／Phase2 指摘2） -----------------
// candidatePromote.test.ts / duplicates.test.ts と同方式: 専用 SQLite に DATABASE_URL を向けてから
// client / route を動的 import する。dev.db は触らない。

let dbDir: string;
let prisma: PrismaClient;
let candidatesRoute: typeof import("../../app/api/candidates/route");
let duplicatesRoute: typeof import("../../app/api/duplicates/route");
let dismissRoute: typeof import("../../app/api/duplicates/dismiss/route");

const BASE_FEATURES = {
  problemFamily: "請求書の作成と送付",
  targetUser: "個人事業主",
  contextTrigger: "月末の締め作業",
  painStatement: "毎月手作業で請求書を作るのが面倒",
  currentSubstitute: "Excel テンプレート",
};

const NEAR_OVERRIDES = {
  title: "請求書候補（別表現）",
  contextTrigger: "監査対応",
  currentSubstitute: "基幹システム",
};

type Suggestion = { a: { id: string }; b: { id: string }; score: number };

async function createCandidate(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
  const res = await candidatesRoute.POST(
    new Request("http://localhost/api/candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "重複永続化テスト候補", ...BASE_FEATURES, ...overrides }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

function listPairs(): Promise<Response> {
  return duplicatesRoute.GET(new Request("http://localhost/api/duplicates"));
}

async function pairIds(res: Response): Promise<Suggestion[]> {
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Suggestion[] }).data;
}

function dismiss(body: Record<string, unknown>): Promise<Response> {
  return dismissRoute.POST(
    new Request("http://localhost/api/duplicates/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("抑制の永続化と一覧除外（GET /api/duplicates）", () => {
  beforeAll(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "mi-dup-dismiss-"));
    const url = `file:${join(dbDir, "test.db")}`;
    process.env.DATABASE_URL = url;
    execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "ignore",
    });
    ({ prisma } = await import("../../lib/db/client"));
    candidatesRoute = await import("../../app/api/candidates/route");
    duplicatesRoute = await import("../../app/api/duplicates/route");
    dismissRoute = await import("../../app/api/duplicates/dismiss/route");
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dbDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.duplicateDismissal.deleteMany();
    await prisma.evidence.deleteMany();
    await prisma.rawSignal.deleteMany();
    await prisma.candidate.deleteMany();
  });

  it("抑制すると一覧から除外され、再取得しても復活しない", async () => {
    const a = await createCandidate();
    const b = await createCandidate(NEAR_OVERRIDES);

    // 抑制前: 似たペアが 1 件出る。
    const before = await pairIds(await listPairs());
    expect(before).toHaveLength(1);

    // Keep Separate で抑制を永続化。
    const dismissed = await dismiss({
      candidateAId: a.id,
      candidateBId: b.id,
      kind: "keep_separate",
    });
    expect(dismissed.status).toBe(201);

    // 取得時に除外される。
    expect(await pairIds(await listPairs())).toHaveLength(0);
    // 再取得（リロード相当）でも復活しない。
    expect(await pairIds(await listPairs())).toHaveLength(0);
  });

  it("抑制は左右の順序に依らず効く（無向ペア）", async () => {
    const a = await createCandidate();
    const b = await createCandidate(NEAR_OVERRIDES);
    // 逆順（b, a）で抑制しても同じペアが除外される。
    expect((await dismiss({ candidateAId: b.id, candidateBId: a.id, kind: "not_duplicate" })).status).toBe(201);
    expect(await pairIds(await listPairs())).toHaveLength(0);
  });

  it("不正な抑制リクエストは 400（候補 ID 欠落 / 不正な kind）", async () => {
    expect((await dismiss({ candidateBId: "x", kind: "keep_separate" })).status).toBe(400);
    expect((await dismiss({ candidateAId: "x", candidateBId: "y", kind: "bogus" })).status).toBe(400);
  });
});
