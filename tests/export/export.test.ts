import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Candidate export（task-32・spec v2 §10.2 / §10.3）。
// 1) candidateToMarkdown が §10.2 テンプレで生成される（純粋関数）
// 2) deepResearch が不足 evidenceType を正しく列挙する（差分テスト・純粋関数）
// 3) API が ?format で markdown / deep-research の両形式を返す（本物の route→repo→DB 経路）
// 4) ExportButton の取得純関数（fetchExport / endpoint）が fetcher DI で動く
//
// API テストは decisionLogRoute.test.ts と同方式: 専用 SQLite に DATABASE_URL を向けてから
// client / handler を動的 import する。dev.db は触らない。import は相対パス（@/ 非対応）。

import {
  candidateToMarkdown,
  distinctSources,
  type MarkdownEvidence,
} from "../../lib/export/candidateMarkdown";
import {
  candidateToDeepResearch,
  evidenceTypeCoverage,
  EVIDENCE_TYPE_LABELS,
} from "../../lib/export/deepResearch";
import { EVIDENCE_TYPE_VALUES } from "../../lib/validation/enums";
import {
  exportEndpoint,
  exportFilename,
  fetchExport,
} from "../../components/candidate/ExportButton";

describe("candidateToMarkdown（§10.2 テンプレ）", () => {
  const candidate = {
    title: "請求書テンプレ自動化",
    displayId: "CND-001",
    targetUser: "個人事業主",
    contextTrigger: "月末の請求作業",
    painStatement: "Excel 手作業が辛い",
    currentSubstitute: "Excel テンプレ",
    spendType: "subscription",
    monetizationGuess: "月額 1000 円",
    problemFamily: "バックオフィス",
    productFormFit: ["web", "mobile"],
    initialScore: 3.5,
    detailedScore: 4.2,
    confidence: 0.42,
    founderFit: 4,
    buildEase: 3,
    legalRisk: 1,
    opsRisk: 2,
    nextAction: "LP でスモークテスト",
  };
  const evidence: MarkdownEvidence[] = [
    {
      evidenceType: "spend",
      strength: 4,
      sourceType: "app_store",
      sourceName: "App Store",
      sourceUrl: "https://example.com/a",
    },
    {
      evidenceType: "search",
      strength: 3,
      sourceType: "seo",
      sourceName: "Search Console",
      sourceUrl: "https://example.com/b",
    },
  ];

  it("テンプレの見出しが順に並ぶ", () => {
    const md = candidateToMarkdown(candidate, evidence);
    expect(md).toContain("# Candidate: CND-001 請求書テンプレ自動化");
    expect(md).toContain("## 対象ユーザー / 状況 / 痛み / 現代替手段");
    expect(md).toContain("## Evidence（type・strength・sourceUrl）");
    expect(md).toContain("## スコア（initial / detailed / confidence / distinctSources）");
    expect(md).toContain("## リスク / 次アクション");
  });

  it("基本情報・スコア・Evidence・distinctSources を埋める", () => {
    const md = candidateToMarkdown(candidate, evidence);
    expect(md).toContain("個人事業主");
    expect(md).toContain("Excel 手作業が辛い");
    expect(md).toContain("spend（strength 4）: https://example.com/a — App Store");
    expect(md).toContain("search（strength 3）: https://example.com/b — Search Console");
    expect(md).toContain("初期スコア: 3.5");
    expect(md).toContain("詳細スコア: 4.2");
    expect(md).toContain("確信度: 0.42");
    // 一次ソース種別（app_store / seo）が 2 種。
    expect(md).toContain("一次ソース種別数: 2");
  });

  it("Evidence 0 件・未設定値は欠落表記になる", () => {
    const md = candidateToMarkdown({ title: "最小候補" }, []);
    expect(md).toContain("# Candidate: 最小候補");
    expect(md).toContain("（Evidence なし）");
    expect(md).toContain("初期スコア: —");
    expect(md).toContain("一次ソース種別数: 0");
  });

  it("distinctSources は sourceType を重複排除する", () => {
    expect(
      distinctSources([
        { evidenceType: "spend", strength: 1, sourceType: "review" },
        { evidenceType: "dissatisfaction", strength: 1, sourceType: "review" },
        { evidenceType: "search", strength: 1, sourceType: "seo" },
        { evidenceType: "job", strength: 1 },
      ]),
    ).toBe(2);
  });
});

describe("evidenceTypeCoverage / deepResearch（§10.3 不足自動算出）", () => {
  it("想定集合に対し present / missing を差分で算出する", () => {
    const { present, missing } = evidenceTypeCoverage(["spend", "search", "spend"]);
    expect(present).toEqual(["spend", "search"]);
    // 想定 8 種 − link 済み 2 種 = 不足 6 種。
    expect(missing).toEqual(["dissatisfaction", "community", "outsourcing", "job", "regulation", "founder"]);
    expect(present.length + missing.length).toBe(EVIDENCE_TYPE_VALUES.length);
  });

  it("想定外の文字列は無視する", () => {
    const { present, missing } = evidenceTypeCoverage(["spend", "bogus"]);
    expect(present).toEqual(["spend"]);
    expect(missing).not.toContain("bogus");
  });

  it("全種別 link 済みなら missing は空", () => {
    const { missing } = evidenceTypeCoverage([...EVIDENCE_TYPE_VALUES]);
    expect(missing).toEqual([]);
  });

  it("プロンプトに不足 Evidence を列挙する", () => {
    const md = candidateToDeepResearch(
      { title: "請求書テンプレ自動化", displayId: "CND-001", targetUser: "個人事業主" },
      ["spend"],
    );
    expect(md).toContain("以下の候補について追加調査してください。");
    expect(md).toContain("## 不足しているEvidence（自動算出）");
    // spend は present 側、search は不足側に出る。
    expect(md).toContain(`- spend（${EVIDENCE_TYPE_LABELS.spend}）`);
    expect(md).toContain(`- search（${EVIDENCE_TYPE_LABELS.search}）`);
  });
});

describe("ExportButton 取得純関数", () => {
  it("endpoint / filename が format で切り替わる", () => {
    expect(exportEndpoint("c1", "markdown")).toBe("/api/candidates/c1/export?format=markdown");
    expect(exportEndpoint("c1", "deep-research")).toBe(
      "/api/candidates/c1/export?format=deep-research",
    );
    expect(exportFilename("CND-001", "markdown")).toBe("CND-001.md");
    expect(exportFilename("CND-001", "deep-research")).toBe("CND-001-deep-research.md");
  });

  it("fetchExport は本文テキストを返し、!ok は throw する", async () => {
    const ok: typeof fetch = async () => new Response("# Candidate: x", { status: 200 });
    await expect(fetchExport("c1", "markdown", ok)).resolves.toContain("# Candidate: x");

    const ng: typeof fetch = async () => new Response("err", { status: 500 });
    await expect(fetchExport("c1", "markdown", ng)).rejects.toThrow(/失敗/);
  });
});

describe("GET /api/candidates/[id]/export", () => {
  let dbDir: string;
  let prisma: PrismaClient;
  let route: typeof import("../../app/api/candidates/[id]/export/route");
  let seq = 0;

  function idCtx(id: string): { params: Promise<{ id: string }> } {
    return { params: Promise.resolve({ id }) };
  }

  beforeAll(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "mi-export-"));
    const url = `file:${join(dbDir, "test.db")}`;
    process.env.DATABASE_URL = url;
    execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "ignore",
    });
    ({ prisma } = await import("../../lib/db/client"));
    route = await import("../../app/api/candidates/[id]/export/route");
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dbDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.evidence.deleteMany();
    await prisma.rawSignal.deleteMany();
    await prisma.candidate.deleteMany();
  });

  async function seedCandidateWithEvidence(): Promise<{ id: string }> {
    seq += 1;
    const candidate = await prisma.candidate.create({
      data: {
        displayId: `CND-EX-${seq}`,
        title: "エクスポート対象候補",
        targetUser: "個人事業主",
        painStatement: "手作業が辛い",
        initialScore: 3.5,
        confidence: 0.4,
      },
    });
    const rs = await prisma.rawSignal.create({
      data: {
        displayId: `RS-EX-${seq}`,
        sourceType: "app_store",
        sourceName: "App Store",
        sourceUrl: "https://example.com/spend",
        rawText: "課金している人が多い",
      },
    });
    await prisma.evidence.create({
      data: {
        candidateId: candidate.id,
        rawSignalId: rs.id,
        evidenceType: "spend",
        strength: 4,
      },
    });
    return candidate;
  }

  it("format=markdown で §10.2 Markdown を text/markdown で返す", async () => {
    const cnd = await seedCandidateWithEvidence();
    const res = await route.GET(
      new Request(`http://localhost/x?format=markdown`),
      idCtx(cnd.id),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("# Candidate: ");
    expect(body).toContain("## Evidence（type・strength・sourceUrl）");
    // 一次ソースの URL が join されて載る。
    expect(body).toContain("https://example.com/spend");
    expect(body).toContain("spend（strength 4）");
  });

  it("format=deep-research で不足 Evidence を列挙して返す", async () => {
    const cnd = await seedCandidateWithEvidence();
    const res = await route.GET(
      new Request(`http://localhost/x?format=deep-research`),
      idCtx(cnd.id),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("## 不足しているEvidence（自動算出）");
    // spend は link 済み（present）、search は不足側に出る。
    expect(body).toContain("- search（");
  });

  it("format 未指定は markdown 既定で 200", async () => {
    const cnd = await seedCandidateWithEvidence();
    const res = await route.GET(new Request(`http://localhost/x`), idCtx(cnd.id));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("# Candidate: ");
  });

  it("不正 format は 400", async () => {
    const cnd = await seedCandidateWithEvidence();
    const res = await route.GET(
      new Request(`http://localhost/x?format=csv`),
      idCtx(cnd.id),
    );
    expect(res.status).toBe(400);
  });

  it("存在しない candidate は 404", async () => {
    const res = await route.GET(
      new Request(`http://localhost/x?format=markdown`),
      idCtx("does-not-exist"),
    );
    expect(res.status).toBe(404);
  });
});
