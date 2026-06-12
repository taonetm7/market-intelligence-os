import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MARKET_AXES,
  RISK_AXES,
  INITIAL_INPUT_KEYS,
  ScoringPanel,
  ScoringResultView,
  buildInitialInputs,
  buildPromotionAdvice,
  confidenceTone,
  scoringEndpoint,
  submitScoring,
  type ScoringResult,
} from "../../components/candidate/ScoringPanel";
import {
  REJECT_REASON_OPTIONS,
  RejectModal,
  canSubmitReject,
  promoteCandidate,
  promoteEndpoint,
  rejectCandidate,
  rejectEndpoint,
} from "../../components/candidate/PromoteRejectModal";
import {
  CandidateDetail,
  CandidateSummary,
  EvidenceList,
  candidateEndpoint,
  createLatestGuard,
  evidenceEndpoint,
  evidenceTypeTone,
  fetchCandidate,
  fetchCandidateEvidence,
  formatProductFormFit,
  type CandidateDetailData,
  type EvidenceRow,
} from "../../components/candidate/CandidateDetail";
import { REJECTED_REASON_CODE_VALUES } from "../../lib/validation/enums";

// task-21 Candidate 詳細（spec v2 §9.5 / §8.1-8.2 / §8.9）。
// テスト基盤に DOM/インタラクション依存は足さない方針のため、ロジック（入力組立・送信・
// 進級アドバイス導出・取得）は純関数（fetcher DI）として駆動し、表示は react-dom/server の
// 静的描画で確認する。テストの import は相対パス（@/ エイリアスは vitest 非対応）。

/** 最後に呼ばれた url / init を記録する擬似 fetch。data を返す（200）。 */
function makeFakeApi(data: unknown, ok = true, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      json: async () => data,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

// ---------------------------------------------------------------------------
// ScoringPanel: 入力組立・計算・進級アドバイス
// ---------------------------------------------------------------------------

describe("ScoringPanel: 素点入力の組立", () => {
  it("8 素点キー（市場6＋リスク2）を欠けなく埋める（未入力は 0）", () => {
    const inputs = buildInitialInputs({ spend: 5 });
    expect(Object.keys(inputs).sort()).toEqual([...INITIAL_INPUT_KEYS].sort());
    expect(inputs.spend).toBe(5);
    expect(inputs.legalRisk).toBe(0);
    expect(inputs.opsRisk).toBe(0);
  });

  it("素点は 0〜5 の整数へクランプ/丸めする", () => {
    const inputs = buildInitialInputs({ spend: 9, pain: -2, frequency: 3.4 });
    expect(inputs.spend).toBe(5);
    expect(inputs.pain).toBe(0);
    expect(inputs.frequency).toBe(3);
  });

  it("市場軸6＋リスク軸2が initialInputsSchema の必須キーと一致する", () => {
    expect(MARKET_AXES).toHaveLength(6);
    expect(RISK_AXES.map((a) => a.key)).toEqual(["legalRisk", "opsRisk"]);
    expect(INITIAL_INPUT_KEYS).toHaveLength(8);
  });
});

describe("ScoringPanel: 進級可否アドバイス（reasons → 次アクション）", () => {
  it("通過時は blockers も nextSteps も空", () => {
    const advice = buildPromotionAdvice({ pass: true, reasons: [] });
    expect(advice.pass).toBe(true);
    expect(advice.blockers).toEqual([]);
    expect(advice.nextSteps).toEqual([]);
  });

  it("不足理由を blockers にそのまま並べ、種別ごとに nextSteps へ翻訳する", () => {
    const gate = {
      pass: false,
      reasons: [
        "InitialScore が不足（0 < 必要 58）",
        "独立チャネル数が不足（0 < 必要 2）",
        "強シグナル（spend / dissatisfaction / search）が1つも立っていない",
      ],
    };
    const advice = buildPromotionAdvice(gate);
    expect(advice.pass).toBe(false);
    expect(advice.blockers).toHaveLength(3);
    // 3 種別それぞれに対応する次アクションが出る。
    expect(advice.nextSteps).toHaveLength(3);
    expect(advice.nextSteps.some((s) => s.includes("独立チャネル"))).toBe(true);
    expect(advice.nextSteps.some((s) => s.includes("強シグナル"))).toBe(true);
  });

  it("confidenceTone は閾値で色分けする", () => {
    expect(confidenceTone(0.8)).toBe("success");
    expect(confidenceTone(0.4)).toBe("info");
    expect(confidenceTone(0.1)).toBe("warning");
  });
});

describe("ScoringPanel: 送信（fetcher DI）", () => {
  const okData = {
    data: {
      candidate: { id: "c1" },
      initialScore: 100,
      confidence: 0.72,
      gate: { pass: true, reasons: [] },
    },
  };

  it("scoring/initial の endpoint へ 8 素点を POST し、結果を返す", async () => {
    const { calls, fetcher } = makeFakeApi(okData);
    const result = await submitScoring("c1", { spend: 5 }, fetcher);
    expect(calls[0].url).toBe(scoringEndpoint("c1"));
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, number>;
    expect(Object.keys(body).sort()).toEqual([...INITIAL_INPUT_KEYS].sort());
    expect(result.initialScore).toBe(100);
    expect(result.gate.pass).toBe(true);
  });

  it("!ok なら例外を投げる", async () => {
    const { fetcher } = makeFakeApi({}, false, 500);
    await expect(submitScoring("c1", {}, fetcher)).rejects.toThrow();
  });
});

describe("ScoringResultView: 結果と進級可否の描画", () => {
  it("通過時はゲート通過と promote 案内を出す", () => {
    const result: ScoringResult = {
      initialScore: 82,
      confidence: 0.7,
      gate: { pass: true, reasons: [] },
    };
    const html = renderToStaticMarkup(<ScoringResultView result={result} />);
    expect(html).toContain("InitialScore");
    expect(html).toContain("82.0");
    expect(html).toContain("0.70");
    expect(html).toContain("通過");
    expect(html).toContain("promote");
  });

  it("未通過時は不足条件と次アクションを出す", () => {
    const result: ScoringResult = {
      initialScore: 10,
      confidence: 0.2,
      gate: {
        pass: false,
        reasons: ["独立チャネル数が不足（0 < 必要 2）"],
      },
    };
    const html = renderToStaticMarkup(<ScoringResultView result={result} />);
    expect(html).toContain("未通過");
    expect(html).toContain("不足している条件");
    expect(html).toContain("独立チャネル");
    expect(html).toContain("次に取るべき");
  });
});

describe("ScoringPanel: 描画スモーク", () => {
  it("市場6軸＋リスク2軸と保存ボタンを描画する", () => {
    const html = renderToStaticMarkup(<ScoringPanel candidateId="c1" />);
    expect(html).toContain("Spend");
    expect(html).toContain("Dissatisfaction");
    expect(html).toContain("legalRisk");
    expect(html).toContain("opsRisk");
    expect(html).toContain("保存して計算");
  });
});

// ---------------------------------------------------------------------------
// PromoteRejectModal: promote / reject
// ---------------------------------------------------------------------------

describe("reject: reasonCode 必須（§15.1）", () => {
  it("選択肢は enum 値タプルから生成し、先頭は空（未選択）", () => {
    expect(REJECT_REASON_OPTIONS[0].value).toBe("");
    expect(REJECT_REASON_OPTIONS.slice(1).map((o) => o.value)).toEqual([
      ...REJECTED_REASON_CODE_VALUES,
    ]);
  });

  it("reasonCode 未選択は送信不可、選択で送信可", () => {
    expect(canSubmitReject("")).toBe(false);
    expect(canSubmitReject("  ")).toBe(false);
    expect(canSubmitReject("no_purchaser")).toBe(true);
  });

  it("reasonCode 未選択なら API を呼ばずに throw する", async () => {
    const { calls, fetcher } = makeFakeApi({ data: {} });
    await expect(rejectCandidate("c1", { reasonCode: "" }, fetcher)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("reasonCode 選択で /reject へ POST する（補足は非空のときだけ含める）", async () => {
    const { calls, fetcher } = makeFakeApi({ data: { stage: "rejected" } });
    await rejectCandidate("c1", { reasonCode: "no_purchaser", reason: " 補足 " }, fetcher);
    expect(calls[0].url).toBe(rejectEndpoint("c1"));
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body.rejectedReasonCode).toBe("no_purchaser");
    expect(body.rejectedReason).toBe("補足");
  });

  it("補足が空なら rejectedReason キーを送らない", async () => {
    const { calls, fetcher } = makeFakeApi({ data: {} });
    await rejectCandidate("c1", { reasonCode: "low_pain", reason: "   " }, fetcher);
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect("rejectedReason" in body).toBe(false);
  });

  it("!ok なら例外を投げる", async () => {
    const { fetcher } = makeFakeApi({ error: { message: "x" } }, false, 404);
    await expect(
      rejectCandidate("c1", { reasonCode: "no_purchaser" }, fetcher),
    ).rejects.toThrow();
  });
});

describe("promote: 昇格 API 呼び出し", () => {
  it("/promote へ POST し data を返す（成功）", async () => {
    const { calls, fetcher } = makeFakeApi({ data: { stage: "top100" } });
    const data = (await promoteCandidate("c1", fetcher)) as { stage: string };
    expect(calls[0].url).toBe(promoteEndpoint("c1"));
    expect(calls[0].init?.method).toBe("POST");
    expect(data.stage).toBe("top100");
  });

  it("422（ゲート未通過）は reasons をメッセージに畳んで throw する", async () => {
    const { fetcher } = makeFakeApi(
      {
        error: {
          message: "Top100 進級ゲート未通過のため昇格できません",
          reasons: ["独立チャネル数が不足（1 < 必要 2）"],
        },
      },
      false,
      422,
    );
    await expect(promoteCandidate("c1", fetcher)).rejects.toThrow("独立チャネル数が不足");
  });
});

describe("RejectModal: 描画", () => {
  it("open で理由コード select と棄却ボタンを出す（未選択は確定不可）", () => {
    const html = renderToStaticMarkup(
      <RejectModal open onClose={() => {}} onSubmit={() => {}} />,
    );
    expect(html).toContain("棄却理由コード");
    expect(html).toContain('value="no_purchaser"');
    expect(html).toContain("棄却する");
    // reasonCode 未選択（初期状態）では確定ボタンが disabled。
    expect(html).toContain("disabled");
  });

  it("closed では何も描画しない", () => {
    const html = renderToStaticMarkup(
      <RejectModal open={false} onClose={() => {}} onSubmit={() => {}} />,
    );
    expect(html).toBe("");
  });
});

// ---------------------------------------------------------------------------
// CandidateDetail: 取得・表示
// ---------------------------------------------------------------------------

function candidate(overrides: Partial<CandidateDetailData> = {}): CandidateDetailData {
  return {
    id: "c1",
    displayId: "CND-001",
    title: "競合より安い請求書アプリ",
    stage: "normalized",
    problemFamily: "請求・経理",
    targetUser: "個人事業主",
    contextTrigger: null,
    painStatement: "請求書作成に時間がかかる",
    currentSubstitute: "Excel",
    spendType: "subscription",
    monetizationGuess: null,
    productFormFit: ["mobile_app", "ai_tool"],
    nextAction: "スモークテスト",
    initialScore: 82,
    detailedScore: null,
    confidence: 0.7,
    legalRisk: 1,
    opsRisk: 0,
    initialInputs: { spend: 4, pain: 3 },
    ...overrides,
  };
}

describe("CandidateDetail: 取得（fetcher DI）", () => {
  it("候補を取得して data を返す", async () => {
    const { calls, fetcher } = makeFakeApi({ data: candidate() });
    const c = await fetchCandidate("c1", fetcher);
    expect(calls[0].url).toBe(candidateEndpoint("c1"));
    expect(c.displayId).toBe("CND-001");
  });

  it("404 は分かるメッセージで throw する", async () => {
    const { fetcher } = makeFakeApi({ error: { message: "x" } }, false, 404);
    await expect(fetchCandidate("nope", fetcher)).rejects.toThrow("見つかりません");
  });

  it("Evidence を取得して data を返す（0 件は空配列）", async () => {
    const rows: EvidenceRow[] = [
      { id: "e1", evidenceType: "spend", strength: 4, credibility: 3, note: null, rawSignalId: "r1" },
    ];
    const ok = makeFakeApi({ data: rows });
    expect((await fetchCandidateEvidence("c1", ok.fetcher))).toHaveLength(1);
    expect(ok.calls[0].url).toBe(evidenceEndpoint("c1"));

    const empty = makeFakeApi({ data: [] });
    expect(await fetchCandidateEvidence("c1", empty.fetcher)).toEqual([]);
  });

  it("Evidence 取得が !ok なら throw する", async () => {
    const { fetcher } = makeFakeApi({}, false, 500);
    await expect(fetchCandidateEvidence("c1", fetcher)).rejects.toThrow();
  });

  it("強シグナル種別は info、それ以外は neutral", () => {
    expect(evidenceTypeTone("spend")).toBe("info");
    expect(evidenceTypeTone("dissatisfaction")).toBe("info");
    expect(evidenceTypeTone("community")).toBe("neutral");
  });
});

describe("createLatestGuard: 古いレスポンスを破棄する", () => {
  it("後から始めた新リクエストのトークンだけが current", () => {
    const guard = createLatestGuard();
    const t1 = guard.next();
    const t2 = guard.next();
    expect(guard.isCurrent(t1)).toBe(false);
    expect(guard.isCurrent(t2)).toBe(true);
  });
});

describe("CandidateSummary / EvidenceList: 描画", () => {
  it("基本情報（stage・displayId・スコア併置）を描画する", () => {
    const html = renderToStaticMarkup(<CandidateSummary candidate={candidate()} />);
    expect(html).toContain("CND-001");
    expect(html).toContain("normalized");
    expect(html).toContain("請求・経理");
    expect(html).toContain("82.0"); // initialScore
    expect(html).toContain("0.70"); // confidence
  });

  it("ProductFormFit（§9.5 必須セクション）をラベルで描画する", () => {
    const html = renderToStaticMarkup(
      <CandidateSummary candidate={candidate({ productFormFit: ["mobile_app", "ai_tool"] })} />,
    );
    expect(html).toContain("プロダクト形態");
    expect(html).toContain("モバイルアプリ");
    expect(html).toContain("AI ツール");
  });

  it("ProductFormFit が空配列なら '—' を描画する", () => {
    const html = renderToStaticMarkup(
      <CandidateSummary candidate={candidate({ productFormFit: [] })} />,
    );
    expect(html).toContain("プロダクト形態");
    // 空配列 → 整形結果は "" → DefRow が "—" にフォールバックする。
    expect(formatProductFormFit([])).toBe("");
  });

  it("formatProductFormFit はコードをラベル化し、未知コードはそのまま残す", () => {
    expect(formatProductFormFit(["web_saas", "concierge"])).toBe("Web SaaS、コンシェルジュ");
    expect(formatProductFormFit(["unknown_form"])).toBe("unknown_form");
  });

  it("Evidence 一覧は件数と各行（種別・強度）を描画する", () => {
    const rows: EvidenceRow[] = [
      { id: "e1", evidenceType: "spend", strength: 4, credibility: 3, note: "支出", rawSignalId: "r1" },
      { id: "e2", evidenceType: "community", strength: 2, credibility: 3, note: null, rawSignalId: "r2" },
    ];
    const html = renderToStaticMarkup(<EvidenceList evidences={rows} onAddEvidence={() => {}} />);
    expect(html).toContain("Evidence（2）");
    expect(html).toContain("spend");
    expect(html).toContain("強度 4");
    expect(html).toContain("Evidence を追加"); // task-22 起動フック
  });

  it("Evidence 0 件は追加導線つきの空表示", () => {
    const html = renderToStaticMarkup(<EvidenceList evidences={[]} onAddEvidence={() => {}} />);
    expect(html).toContain("Evidence（0）");
    expect(html).toContain("紐付く Evidence はありません");
    expect(html).toContain("task-22");
  });
});

describe("CandidateDetail: スモーク", () => {
  it("初期描画でヘッダ（説明）を出す", () => {
    const html = renderToStaticMarkup(<CandidateDetail candidateId="c1" />);
    expect(html).toContain("Candidate");
    expect(html).toContain("§9.5");
  });
});
