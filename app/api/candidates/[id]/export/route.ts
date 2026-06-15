// Candidate export API — task-32, spec v2 §10.2 / §10.3。
//
// GET /api/candidates/[id]/export?format=markdown|deep-research —
//   format=markdown      → §10.2 の候補 Markdown（基本情報・Evidence・スコア・リスク）
//   format=deep-research → §10.3 の Deep Research プロンプト（不足 Evidence を自動算出）
// を text/markdown で返す。生成は純粋関数（lib/export/*）に委譲し、ここはデータ収集と HTTP 翻訳
// だけを行う薄い route（既存 route の流儀）。Prisma は直接触らず repository 経由で集める。
//
// markdown は Evidence の sourceUrl/sourceType（RawSignal 側）が要るため、evidenceRepo で link を
// 取り、rawSignalRepo で一次ソースを引いて射影する（単一ローカルユーザー前提で件数は小さい）。
// deep-research は evidenceType だけで足りるため RawSignal は引かない。
//
// エラー → HTTP の翻訳:
// - format が markdown / deep-research 以外 → 400
// - candidate が存在しない                 → 404
// - それ以外                               → 500
//
// 成功は 200・text/markdown（charset=utf-8）＋ Content-Disposition（DL 用 filename）。
// 成功はテキスト本文、失敗は既存 API と同じ { error } JSON 一貫形。
//
// Next.js 16: route handler の `context.params` は Promise。必ず await して取り出す。

import { z } from "zod";

import { candidateRepo } from "../../../../../lib/db/candidateRepo";
import { evidenceRepo } from "../../../../../lib/db/evidenceRepo";
import { rawSignalRepo } from "../../../../../lib/db/rawSignalRepo";
import {
  candidateToMarkdown,
  type MarkdownEvidence,
} from "../../../../../lib/export/candidateMarkdown";
import { candidateToDeepResearch } from "../../../../../lib/export/deepResearch";

/** 動的セグメント [id]（= candidateId）を持つ route handler のコンテキスト型（params は Promise）。 */
type RouteContext = { params: Promise<{ id: string }> };

/** export 形式の語彙（ドメイン enum ではなく API パラメータ）。既定は markdown。 */
const exportFormatSchema = z.enum(["markdown", "deep-research"]).default("markdown");

/**
 * Evidence（link）を Markdown 用に射影する。各 link の rawSignalId から一次ソースを引き、
 * sourceType（distinctSources 用）と sourceUrl/sourceName を付ける。同一 rawSignal は 1 回だけ引く。
 */
async function toMarkdownEvidence(
  evidence: Awaited<ReturnType<typeof evidenceRepo.listByCandidate>>,
): Promise<MarkdownEvidence[]> {
  const cache = new Map<string, Awaited<ReturnType<typeof rawSignalRepo.getById>>>();
  const out: MarkdownEvidence[] = [];
  for (const e of evidence) {
    if (!cache.has(e.rawSignalId)) {
      cache.set(e.rawSignalId, await rawSignalRepo.getById(e.rawSignalId));
    }
    const signal = cache.get(e.rawSignalId) ?? null;
    out.push({
      evidenceType: e.evidenceType,
      strength: e.strength,
      sourceType: signal?.sourceType ?? null,
      sourceName: signal?.sourceName ?? null,
      sourceUrl: signal?.sourceUrl ?? null,
    });
  }
  return out;
}

/**
 * GET /api/candidates/[id]/export — format に応じた Markdown を返す。
 * 不正 format は 400、存在しない candidate は 404。
 */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { id } = await ctx.params;

    const rawFormat = new URL(request.url).searchParams.get("format");
    const parsedFormat = exportFormatSchema.safeParse(rawFormat ?? undefined);
    if (!parsedFormat.success) {
      return Response.json(
        { error: { message: "format は markdown / deep-research のいずれかです" } },
        { status: 400 },
      );
    }

    const candidate = await candidateRepo.getById(id);
    if (candidate === null) {
      return Response.json({ error: { message: "Candidate が見つかりません" } }, { status: 404 });
    }

    const evidence = await evidenceRepo.listByCandidate(id);
    const base = candidate.displayId ?? candidate.id;

    let content: string;
    let filename: string;
    if (parsedFormat.data === "markdown") {
      content = candidateToMarkdown(candidate, await toMarkdownEvidence(evidence));
      filename = `${base}.md`;
    } else {
      content = candidateToDeepResearch(
        candidate,
        evidence.map((e) => e.evidenceType),
      );
      filename = `${base}-deep-research.md`;
    }

    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch {
    return Response.json({ error: { message: "サーバ内部エラー" } }, { status: 500 });
  }
}
