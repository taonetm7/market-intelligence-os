import { describe, expect, it } from "vitest";

import { parseCsv, parseJson } from "../../lib/import/parse";

// task-14 acceptance criteria (spec v2 §10.1):
// - 正常 JSON/CSV を valid に変換する
// - 必須欠落・enum 不正の行が invalid に「行番号＋理由」付きで入る
// - tags の区切り（JSON は配列 / CSV はセミコロン）→ 配列変換
// - パーサは純粋（文字列 or オブジェクトを受けて結果を返す）

describe("parseJson", () => {
  const validSignal = {
    sourceType: "review",
    sourceName: "App Store",
    sourceUrl: "https://example.com/app",
    rawText: "星1〜3に『日本語対応が弱い』が反復",
    observedEntity: "○○ App",
    tags: ["localization", "productivity"],
    extra: { stars: "1-3", complaintTag: "localization" },
  };

  it("正常 JSON 文字列を valid に変換し、tags→signalTags・origin=import に正規化する", () => {
    const result = parseJson(JSON.stringify({ rawSignals: [validSignal] }));

    expect(result.invalid).toEqual([]);
    expect(result.valid).toHaveLength(1);
    const [signal] = result.valid;
    expect(signal.sourceType).toBe("review");
    expect(signal.rawText).toContain("日本語対応");
    // §10.1 の `tags` は内部表現 `signalTags` に寄せられる。
    expect(signal.signalTags).toEqual(["localization", "productivity"]);
    expect(signal.extra).toEqual({ stars: "1-3", complaintTag: "localization" });
    // import 経由の既定来歴は "import"（§10.1 step4）。
    expect(signal.origin).toBe("import");
    expect(signal.status).toBe("inbox");
  });

  it("既パース済みオブジェクトも受け付ける（純粋・I/O なし）", () => {
    const result = parseJson({ rawSignals: [validSignal] });
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toEqual([]);
  });

  it("明示された origin（例: ai）は尊重する", () => {
    const result = parseJson({ rawSignals: [{ ...validSignal, origin: "ai" }] });
    expect(result.valid[0]?.origin).toBe("ai");
  });

  it("tags 省略時は signalTags が空配列になる", () => {
    const { tags: _omit, ...noTags } = validSignal;
    void _omit;
    const result = parseJson({ rawSignals: [noTags] });
    expect(result.valid[0]?.signalTags).toEqual([]);
  });

  it("必須欠落（rawText なし）の行は invalid に行番号＋理由付きで入る", () => {
    const { rawText: _omit, ...noRawText } = validSignal;
    void _omit;
    const result = parseJson({ rawSignals: [noRawText] });

    expect(result.valid).toEqual([]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.row).toBe(1);
    expect(result.invalid[0]?.errors.join(" ")).toContain("rawText");
  });

  it("enum 不正（sourceType）の行は invalid に行番号＋理由付きで入る", () => {
    const result = parseJson({ rawSignals: [{ ...validSignal, sourceType: "blog" }] });

    expect(result.valid).toEqual([]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.row).toBe(1);
    expect(result.invalid[0]?.errors.join(" ")).toContain("sourceType");
  });

  it("正常行と不正行が混在しても、正しく振り分け・行番号を保持する", () => {
    const result = parseJson({
      rawSignals: [
        validSignal, // row 1: valid
        { ...validSignal, sourceType: "blog" }, // row 2: invalid (enum)
        { ...validSignal, sourceName: "Google Play" }, // row 3: valid
      ],
    });

    expect(result.valid).toHaveLength(2);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.row).toBe(2);
  });

  it("JSON として解釈できない文字列は全体エラー（row=0）", () => {
    const result = parseJson("{ not json");
    expect(result.valid).toEqual([]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.row).toBe(0);
    expect(result.invalid[0]?.errors.join(" ")).toContain("JSON");
  });

  it("rawSignals 配列が無いエンベロープは全体エラー（row=0）", () => {
    const result = parseJson({ signals: [] });
    expect(result.valid).toEqual([]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.row).toBe(0);
    expect(result.invalid[0]?.errors.join(" ")).toContain("rawSignals");
  });
});

describe("parseCsv", () => {
  const header = "sourceType,sourceName,sourceUrl,rawText,observedEntity,tags,observedReviews";

  it("正常 CSV を valid に変換し、tags をセミコロン区切り→配列に変換する", () => {
    const csv = [
      header,
      "review,App Store,https://example.com,星1〜3が反復,○○ App,localization;productivity,42",
    ].join("\n");

    const result = parseCsv(csv);

    expect(result.invalid).toEqual([]);
    expect(result.valid).toHaveLength(1);
    const [signal] = result.valid;
    expect(signal.sourceType).toBe("review");
    expect(signal.rawText).toBe("星1〜3が反復");
    // セミコロン区切り → 配列（前後空白除去）。
    expect(signal.signalTags).toEqual(["localization", "productivity"]);
    // 数値列は Number 化される。
    expect(signal.observedReviews).toBe(42);
    expect(signal.origin).toBe("import");
  });

  it("tags のセミコロン区切りで前後空白を除去し、空要素を落とす", () => {
    const csv = [header, "sns,X,,つぶやき,,  a ; b ;;c ,"].join("\n");
    const result = parseCsv(csv);
    expect(result.valid[0]?.signalTags).toEqual(["a", "b", "c"]);
  });

  it("空 tags セルは空配列になる", () => {
    const csv = [header, "community,Reddit,,スレッド,,,"].join("\n");
    const result = parseCsv(csv);
    expect(result.valid[0]?.signalTags).toEqual([]);
  });

  it("必須欠落（rawText 空セル）の行は invalid に行番号付きで入る（ヘッダ=1行目）", () => {
    const csv = [header, "review,App Store,,,○○ App,localization,1"].join("\n");
    const result = parseCsv(csv);

    expect(result.valid).toEqual([]);
    expect(result.invalid).toHaveLength(1);
    // データ 1 行目はファイル 2 行目。
    expect(result.invalid[0]?.row).toBe(2);
    expect(result.invalid[0]?.errors.join(" ")).toContain("rawText");
  });

  it("enum 不正（sourceType）の行は invalid に行番号付きで入る", () => {
    const csv = [header, "blog,X,,本文,,tag,1"].join("\n");
    const result = parseCsv(csv);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.row).toBe(2);
    expect(result.invalid[0]?.errors.join(" ")).toContain("sourceType");
  });

  it("正常行と不正行が混在しても行番号（ファイル行）を保持する", () => {
    const csv = [
      header,
      "review,A,,本文1,,t1,1", // line 2: valid
      "blog,B,,本文2,,t2,2", // line 3: invalid (enum)
      "sns,C,,本文3,,t3,3", // line 4: valid
    ].join("\n");

    const result = parseCsv(csv);
    expect(result.valid).toHaveLength(2);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.row).toBe(3);
  });

  it("引用符で囲んだフィールド内のカンマ・改行を 1 セルとして扱う", () => {
    const csv = [header, '"review","App, Inc.",,"1行目\n2行目",,a;b,7'].join("\n");
    const result = parseCsv(csv);

    expect(result.invalid).toEqual([]);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.sourceName).toBe("App, Inc.");
    expect(result.valid[0]?.rawText).toBe("1行目\n2行目");
  });

  it("空入力は全体エラー（row=0）", () => {
    const result = parseCsv("");
    expect(result.valid).toEqual([]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.row).toBe(0);
  });
});
