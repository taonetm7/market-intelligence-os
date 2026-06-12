// Import 用スキーマ（AI/外部出力の取り込み）— task-14, spec v2 §10.1。
//
// 交換主データは Markdown ではなく JSON(スキーマ準拠) / 固定ヘッダ CSV（§10.1）。
// ここでは task-02 の `rawSignalInputSchema`（lib/validation/schemas.ts）を**再利用**し、
// import 固有の差分だけを薄くラップする。enum / 必須 / 型の検証本体は task-02 に委ねる
// （重複定義しない・共有スキーマは変更しない）。
//
// import 形と内部表現の差分は 2 点だけ:
// 1. タグのキー名: §10.1 の JSON は `tags`、内部表現（task-02）は `signalTags`。
//    → preprocess で `tags` を `signalTags` に寄せる（別名吸収）。
// 2. 来歴(origin): import 経由の既定は "import"（§10.1 step4。AI 由来は明示 "ai"）。
//    → 未指定なら "import" を補う。明示指定された値は尊重する。
//
// Out of scope（task-15 以降）: quarantine 永続化 / accept / sourceUrl 解決チェック / UI。

import { z } from "zod";

import { rawSignalInputSchema } from "../validation/schemas";

/**
 * import 1 レコード分のスキーマ。§10.1 の JSON 形（`tags`・`extra` を持つ）を受け取り、
 * 内部表現 {@link RawSignalInput}（`signalTags`・origin 既定 "import"）へ正規化して検証する。
 *
 * 検証の実体（sourceType の enum・rawText 必須・型）は task-02 の `rawSignalInputSchema`。
 * preprocess は「import 形 → 内部形」への寄せ替えだけを行い、検証ルールは増やさない。
 */
export const rawSignalImportSchema = z.preprocess((raw) => {
  if (typeof raw !== "object" || raw === null) {
    // オブジェクトでなければ素通しし、rawSignalInputSchema 側で型エラーにさせる。
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  const mapped: Record<string, unknown> = { ...obj };

  // (1) §10.1 の `tags` を内部表現の `signalTags` へ。signalTags が明示されていれば尊重。
  if ("tags" in mapped && !("signalTags" in mapped)) {
    mapped.signalTags = mapped.tags;
  }
  delete mapped.tags;

  // (2) import 経由の既定来歴は "import"（§10.1 step4）。"ai" 等の明示指定は尊重する。
  if (mapped.origin === undefined) {
    mapped.origin = "import";
  }

  return mapped;
}, rawSignalInputSchema);

/** import 1 レコードの検証結果型（= 内部表現 RawSignalInput）。 */
export type RawSignalImport = z.infer<typeof rawSignalImportSchema>;

/**
 * import JSON のエンベロープ。§10.1 は `{ "rawSignals": [ ... ] }` の形。
 * ここでは「rawSignals が配列であること」だけを検証し、各要素の検証は parse 側で
 * 1 行ずつ行う（不正行を捨てず行番号付きで残すため・§10.1 step6）。
 */
export const importEnvelopeSchema = z.object({
  rawSignals: z.array(z.unknown()),
});
export type ImportEnvelope = z.infer<typeof importEnvelopeSchema>;
