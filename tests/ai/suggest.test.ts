import { afterEach, describe, expect, it, vi } from "vitest";

// task-39 acceptance（spec v2 §11.1 / §11.2 / §8.9）:
// - 4 アクション（tag-suggest / normalize-draft / missing-evidence / research-prompt）が
//   proposed を返し、DB を直接変更しない（suggest 層は prisma を import しない＝経路が無い）。
// - AI 由来データは origin="ai"。実体反映は task-15 quarantine→accept を通す（batchOrigin が "ai"）。
// - スコア / stage / Evidence strength を AI が動かす経路が無い（出力スキーマに無く、幻覚も落ちる）。
// - API キー未設定でも他機能が壊れない（無効応答・例外を投げない）。
//
// Claude API はモック（AiComplete を差し替え / グローバル fetch を stub）。実ネットワークは叩かない。
// import は相対パス（@/ エイリアスは vitest 非対応）。

import { AiDisabledError, AiRequestError, createAiComplete, isAiEnabled } from "../../lib/ai/client";
import {
  AI_ACTION_VALUES,
  aiActionSchema,
  missingEvidence,
  normalizeDraft,
  researchPrompt,
  tagSuggest,
} from "../../lib/ai/suggest";
import { originSchema } from "../../lib/validation/enums";
import { batchOriginSchema } from "../../lib/import/quarantineRepo";
import { submitProposalToQuarantine } from "../../components/ai/AiDraftPanel";
import { POST } from "../../app/api/ai/[action]/route";

/** 指定 JSON を text ブロックとして返す偽 complete を作る。呼び出し回数も数える。 */
function fakeComplete(payload: unknown) {
  const calls: Array<{ system: string; prompt: string }> = [];
  const fn = async ({ system, prompt }: { system: string; prompt: string }) => {
    calls.push({ system, prompt });
    return JSON.stringify(payload);
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// client.ts
// ---------------------------------------------------------------------------

describe("isAiEnabled", () => {
  it("API キーが空/未設定なら false、非空なら true", () => {
    expect(isAiEnabled({})).toBe(false);
    expect(isAiEnabled({ ANTHROPIC_API_KEY: "" })).toBe(false);
    expect(isAiEnabled({ ANTHROPIC_API_KEY: "   " })).toBe(false);
    expect(isAiEnabled({ ANTHROPIC_API_KEY: "sk-test" })).toBe(true);
  });
});

describe("createAiComplete", () => {
  it("apiKey 未設定なら AiDisabledError を投げる（他機能を壊さないための明示エラー）", async () => {
    const complete = createAiComplete({ apiKey: "" });
    await expect(complete({ system: "s", prompt: "p" })).rejects.toBeInstanceOf(AiDisabledError);
  });

  it("既定モデルで /v1/messages を叩き、text ブロックだけを連結して返す", async () => {
    let captured: { url: string; body: unknown; headers: Record<string, string> } | null = null;
    const fetcher = (async (url: string, init: RequestInit) => {
      captured = {
        url,
        body: JSON.parse(init.body as string),
        headers: init.headers as Record<string, string>,
      };
      return new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "hello " },
            { type: "thinking", text: "（無視されるべき）" },
            { type: "text", text: "world" },
          ],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const complete = createAiComplete({ apiKey: "sk-test", fetcher });
    const text = await complete({ system: "S", prompt: "P" });
    expect(text).toBe("hello world");
    expect(captured!.url).toBe("https://api.anthropic.com/v1/messages");
    expect((captured!.body as { model: string }).model).toBe("claude-opus-4-8");
    expect(captured!.headers["x-api-key"]).toBe("sk-test");
  });

  it("非 2xx は AiRequestError、refusal も AiRequestError に倒す", async () => {
    const errFetcher = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(
      createAiComplete({ apiKey: "k", fetcher: errFetcher })({ system: "s", prompt: "p" }),
    ).rejects.toBeInstanceOf(AiRequestError);

    const refusalFetcher = (async () =>
      new Response(JSON.stringify({ content: [], stop_reason: "refusal" }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(
      createAiComplete({ apiKey: "k", fetcher: refusalFetcher })({ system: "s", prompt: "p" }),
    ).rejects.toBeInstanceOf(AiRequestError);
  });

  // 指摘②: 通信失敗（タイムアウト/ネットワーク断）と応答 JSON 破損は「上流起因の失敗」=
  // AiRequestError に倒す（route で 502。呼び出し側の 500 にしない）。
  it("通信失敗（fetcher が reject）は AiRequestError（上流起因）に倒す", async () => {
    const networkFail = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    await expect(
      createAiComplete({ apiKey: "k", fetcher: networkFail })({ system: "s", prompt: "p" }),
    ).rejects.toBeInstanceOf(AiRequestError);
  });

  it("応答ボディが壊れた JSON（2xx だが parse 不能）も AiRequestError に倒す", async () => {
    const brokenBody = (async () =>
      new Response("not json at all", { status: 200 })) as unknown as typeof fetch;
    await expect(
      createAiComplete({ apiKey: "k", fetcher: brokenBody })({ system: "s", prompt: "p" }),
    ).rejects.toBeInstanceOf(AiRequestError);
  });
});

// ---------------------------------------------------------------------------
// suggest.ts — 4 アクションが proposed を返す（DB 非変更・origin=ai）
// ---------------------------------------------------------------------------

describe("aiActionSchema", () => {
  it("4 アクションだけを受理する", () => {
    expect([...AI_ACTION_VALUES]).toEqual([
      "tag-suggest",
      "normalize-draft",
      "missing-evidence",
      "research-prompt",
    ]);
    expect(aiActionSchema.safeParse("unknown").success).toBe(false);
  });
});

describe("tagSuggest", () => {
  it("proposed.tags を返し、origin は ai", async () => {
    const { fn, calls } = fakeComplete({ tags: ["請求書", "freelancer"] });
    const result = await tagSuggest({ text: "個人事業主が請求書作成に困っている" }, fn);
    expect(result.origin).toBe("ai");
    expect(result.action).toBe("tag-suggest");
    expect(result.proposed.tags).toEqual(["請求書", "freelancer"]);
    expect(calls).toHaveLength(1); // モデルを 1 回だけ呼ぶ（DB は触らない）
  });
});

describe("normalizeDraft", () => {
  it("正規化フィールド下書きを返す（score/stage は出力に含まれない）", async () => {
    const { fn } = fakeComplete({
      title: "請求書作成 SaaS",
      targetUser: "個人事業主",
      painStatement: "請求書作成に時間がかかる",
      // モデルが幻覚で混ぜてきた禁止フィールド（出力スキーマで落ちるべき）。
      score: 5,
      stage: "top30",
    });
    const result = await normalizeDraft({ rawText: "観測テキスト" }, fn);
    expect(result.origin).toBe("ai");
    expect(result.proposed.title).toBe("請求書作成 SaaS");
    expect(result.proposed).not.toHaveProperty("score");
    expect(result.proposed).not.toHaveProperty("stage");
  });
});

describe("missingEvidence", () => {
  it("不足 type に対する提案を返し、不足集合外の type は捨てる", async () => {
    // present に spend / search を渡す → missing は残り 6 種。
    const { fn } = fakeComplete({
      suggestions: [
        { evidenceType: "community", hint: "Reddit を見る", strength: 4 }, // strength は落ちる
        { evidenceType: "spend", hint: "これは present なので捨てられる" },
      ],
    });
    const result = await missingEvidence(
      { presentEvidenceTypes: ["spend", "search"], title: "X" },
      fn,
    );
    expect(result.origin).toBe("ai");
    expect(result.proposed.suggestions).toHaveLength(1);
    expect(result.proposed.suggestions[0].evidenceType).toBe("community");
    expect(result.proposed.suggestions[0]).not.toHaveProperty("strength");
  });

  it("不足が無ければモデルを呼ばず空提案を返す", async () => {
    const { fn, calls } = fakeComplete({ suggestions: [] });
    const all = [
      "spend",
      "dissatisfaction",
      "search",
      "community",
      "outsourcing",
      "job",
      "regulation",
      "founder",
    ];
    const result = await missingEvidence({ presentEvidenceTypes: all }, fn);
    expect(result.proposed.suggestions).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("researchPrompt", () => {
  it("Deep Research プロンプト文字列を返す", async () => {
    const { fn } = fakeComplete({ prompt: "## 候補概要\n調べてください" });
    const result = await researchPrompt({ title: "請求書 SaaS" }, fn);
    expect(result.origin).toBe("ai");
    expect(result.proposed.prompt).toContain("調べてください");
  });
});

// ---------------------------------------------------------------------------
// origin=ai で quarantine 経由（task-15 再利用）
// ---------------------------------------------------------------------------

describe("AI 由来は origin=ai で quarantine 経由になる", () => {
  it("全提案の origin は originSchema の ai", () => {
    expect(originSchema.enum.ai).toBe("ai");
  });

  it("quarantine バッチ origin は ai を受理し manual を拒否する（実体反映の関門）", () => {
    expect(batchOriginSchema.parse("ai")).toBe("ai");
    expect(batchOriginSchema.safeParse("manual").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// route: app/api/ai/[action]
// ---------------------------------------------------------------------------

describe("POST /api/ai/[action]", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
    vi.unstubAllGlobals();
  });

  function post(action: string, body: unknown): Promise<Response> {
    const req = new Request(`http://localhost/api/ai/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(req, { params: Promise.resolve({ action }) });
  }

  it("未知 action は 404", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const res = await post("bogus", { text: "x" });
    expect(res.status).toBe(404);
  });

  it("API キー未設定なら 200 で enabled:false（エラーにしない）", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await post("tag-suggest", { text: "x" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { enabled: boolean } };
    expect(body.data.enabled).toBe(false);
  });

  it("キーありで不正 JSON は 400", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const req = new Request("http://localhost/api/ai/tag-suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    const res = await POST(req, { params: Promise.resolve({ action: "tag-suggest" }) });
    expect(res.status).toBe(400);
  });

  it("キーありの正常系は 200 で proposal（origin=ai）を返す（fetch は stub）", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: JSON.stringify({ tags: ["a", "b"] }) }],
            stop_reason: "end_turn",
          }),
          { status: 200 },
        ),
    );
    const res = await post("tag-suggest", { text: "観測" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { origin: string; proposed: { tags: string[] } } };
    expect(body.data.origin).toBe("ai");
    expect(body.data.proposed.tags).toEqual(["a", "b"]);
  });

  // 指摘②: 上流（Claude）起因の失敗は 500 ではなく 502（Bad Gateway 相当）で返す。
  it("通信失敗は 500 ではなく 502（上流エラー）で返す", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network down");
    });
    const res = await post("tag-suggest", { text: "観測" });
    expect(res.status).toBe(502);
  });

  it("AI 応答ボディが壊れた JSON のときも 500 ではなく 502 で返す", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      async () => new Response("not json at all", { status: 200 }),
    );
    const res = await post("tag-suggest", { text: "観測" });
    expect(res.status).toBe(502);
  });

  it("AI 応答が JSON オブジェクトにならないときも 500 ではなく 502 で返す", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    // HTTP 応答は妥当だが、text ブロックの中身が JSON オブジェクトでない（AiResponseError → 502）。
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "これは JSON ではありません" }],
            stop_reason: "end_turn",
          }),
          { status: 200 },
        ),
    );
    const res = await post("tag-suggest", { text: "観測" });
    expect(res.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// AiDraftPanel: AI 下書きを quarantine(origin=ai) へ送る配線（指摘①の UI 入口）
// ---------------------------------------------------------------------------

describe("submitProposalToQuarantine", () => {
  it("既存 import エンドポイントへ origin=ai で RawSignal 下書きを POST する", async () => {
    let captured: { url: string; body: { origin: string; content: { rawSignals: unknown[] } } } | null =
      null;
    const fetcher = (async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(init.body as string) };
      return new Response(
        JSON.stringify({ data: { batch: { id: "batch-1" }, pending: [{}], invalid: [] } }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;

    const drafts = [{ sourceType: "review", rawText: "AIタグ付き観測", tags: ["x"] }];
    const summary = await submitProposalToQuarantine(drafts, fetcher);

    expect(captured!.url).toBe("/api/raw-signals/import");
    expect(captured!.body.origin).toBe(originSchema.enum.ai); // 直書きせず enum 経由
    expect(captured!.body.content.rawSignals).toEqual(drafts);
    expect(summary.batchId).toBe("batch-1");
    expect(summary.pendingCount).toBe(1);
  });

  it("非 2xx は throw（quarantine 投入失敗を握り潰さない）", async () => {
    const fetcher = (async () =>
      new Response("err", { status: 500 })) as unknown as typeof fetch;
    await expect(submitProposalToQuarantine([{}], fetcher)).rejects.toThrow();
  });
});
