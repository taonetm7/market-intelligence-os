// Claude API クライアント（最小ラッパ）— task-39, spec v2 §11。
//
// AI 支援（draft 提案）のための Claude Messages API ラッパ。**任意機能**であり、
// API キー（ANTHROPIC_API_KEY）未設定時は機能を無効化し、他機能を壊さない（§11 / 本タスク要件）。
//
// 依存方針:
// - 公式 SDK（@anthropic-ai/sdk）は依存追加が許されない（zod 以外の依存追加禁止）ため、
//   Node 22 のグローバル `fetch` で生 HTTP を叩く（claude-api スキルが許す代替路）。
// - 既定モデルは最新の claude-opus-4-8（claude-api スキルの既定。記憶で書かず最新仕様で確定）。
// - thinking は付けない（既定 off）。本機能はタグ候補/下書きなどの軽量抽出で、出力を JSON に
//   束ねて確実に parse したいため、thinking ブロックを発生させず max_tokens 内に収める。
//
// テスト容易性: complete は fetcher / apiKey / model / baseUrl を差し替えられる。テストは
// 実ネットワークを叩かず、`AiComplete` を差し替える（suggest.ts のDI）か createAiComplete に
// 偽 fetcher を渡す。

/** 既定モデル（claude-api スキルの既定・最新の Opus）。 */
export const DEFAULT_AI_MODEL = "claude-opus-4-8";

/** Messages API のバージョンヘッダ / エンドポイント。 */
const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

/** complete の入力。system プロンプトと user プロンプト、任意の max_tokens。 */
export interface AiCompleteParams {
  system: string;
  prompt: string;
  maxTokens?: number;
}

/** suggest 層が差し替え可能な「1 往復でテキストを返す」関数型（テストはこれを偽装する）。 */
export type AiComplete = (params: AiCompleteParams) => Promise<string>;

/** createAiComplete の依存。既定は process.env / グローバル fetch / 既定モデル・URL。 */
export interface AiClientDeps {
  apiKey?: string;
  model?: string;
  fetcher?: typeof fetch;
  baseUrl?: string;
}

/** API キー未設定で AI 機能が無効なときに投げる明示エラー（route 側で握り潰す/無効応答に翻訳）。 */
export class AiDisabledError extends Error {
  constructor() {
    super("AI 機能は無効です（ANTHROPIC_API_KEY 未設定）");
    this.name = "AiDisabledError";
  }
}

/** Claude API が非 2xx / 拒否（refusal）を返したときのエラー。 */
export class AiRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AiRequestError";
  }
}

/**
 * AI 機能が有効か（= API キーが設定されているか）。未設定なら false を返し、呼び出し側は
 * 機能を無効化する（エラーにしない・本タスク要件）。env は差し替え可能（テスト用）。
 */
export function isAiEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const key = env.ANTHROPIC_API_KEY;
  return typeof key === "string" && key.trim() !== "";
}

/** Claude Messages API レスポンスのうち、本ラッパが参照する最小形。 */
interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
}

/**
 * 依存を束ねて AiComplete を生成する。apiKey 未設定なら呼び出し時に AiDisabledError を投げる。
 * 生 HTTP（fetch）で /v1/messages を 1 往復し、text ブロックを連結して返す。
 */
export function createAiComplete(deps: AiClientDeps = {}): AiComplete {
  return async ({ system, prompt, maxTokens }: AiCompleteParams): Promise<string> => {
    const apiKey = deps.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new AiDisabledError();
    }
    const fetcher = deps.fetcher ?? fetch;
    const model = deps.model ?? DEFAULT_AI_MODEL;
    const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;

    const res = await fetcher(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens ?? 2048,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      throw new AiRequestError(res.status, `Claude API エラー（HTTP ${res.status}）`);
    }

    const json = (await res.json()) as MessagesResponse;
    // opus 4.8 は安全分類で stop_reason="refusal"（content 空）を返しうる。明示エラーにする。
    if (json.stop_reason === "refusal") {
      throw new AiRequestError(200, "Claude API がリクエストを拒否しました（refusal）");
    }

    return (json.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
  };
}

/** 既定の AiComplete（process.env / グローバル fetch / 既定モデル）。suggest 層の既定 DI 先。 */
export const defaultComplete: AiComplete = (params) => createAiComplete()(params);
