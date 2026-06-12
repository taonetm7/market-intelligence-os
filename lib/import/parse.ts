// JSON / CSV import パーサ（純粋関数）— task-14, spec v2 §10.1。
//
// AI/外部出力を JSON(スキーマ準拠) または固定ヘッダ CSV で受け取り、task-14 の import
// スキーマ（lib/import/importSchema.ts → task-02 の RawSignalInput を再利用）で 1 行ずつ
// 検証し、「正常行(valid) / 不正行(invalid・行番号＋理由付き)」に分ける。
//
// 設計方針:
// - 純粋関数（I/O なし）。文字列 or 既パース済みオブジェクトを受けて結果を返す。
// - 不正行は捨てない。行番号と Zod エラーメッセージを保持して返す（§10.1 step6・quarantine
//   表示用。本登録/破棄は task-15）。
// - 検証ロジックは importSchema 経由で task-02 のスキーマに委ね、ここでは重複定義しない。

import { z } from "zod";

import {
  importEnvelopeSchema,
  rawSignalImportSchema,
  type RawSignalImport,
} from "./importSchema";

/** 不正行 1 件。`row` は 1 始まりの行番号、`errors` は人間可読の理由（複数可）。 */
export type InvalidRow = {
  /**
   * 1 始まりの行番号。
   * - JSON: `rawSignals[]` 内の位置（1 = 先頭要素）。
   * - CSV: ファイル行番号（ヘッダ = 1 行目。データは 2 行目から）。
   * - `0`: 行を特定できない全体エラー（JSON 解釈不能 / エンベロープ不正 / 空 CSV）。
   */
  row: number;
  errors: string[];
};

/** パース結果。valid は内部表現（RawSignalInput）、invalid は行番号＋理由。 */
export type ParseResult = {
  valid: RawSignalImport[];
  invalid: InvalidRow[];
};

/** ヘッダ名で数値として扱う CSV 列（文字列セルを Number 化する）。 */
const NUMERIC_CSV_COLUMNS = new Set(["observedRating", "observedReviews"]);

/** CSV の `tags` 列の区切り文字（§10.1 / task-14: セミコロン区切り → 配列）。 */
const CSV_TAGS_DELIMITER = ";";

/** ZodError を `"path: message"` 形式の文字列配列へ変換する（quarantine 表示用）。 */
function zodMessages(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/**
 * 行（unknown）の配列を 1 件ずつ検証し、valid / invalid に振り分ける共通ロジック。
 * @param rows        検証対象の行データ
 * @param rowNumberAt 配列 index → 表示用行番号への写像（JSON と CSV で起点が異なる）
 */
function validateRows(rows: unknown[], rowNumberAt: (index: number) => number): ParseResult {
  const valid: RawSignalImport[] = [];
  const invalid: InvalidRow[] = [];

  rows.forEach((row, index) => {
    const result = rawSignalImportSchema.safeParse(row);
    if (result.success) {
      valid.push(result.data);
    } else {
      invalid.push({ row: rowNumberAt(index), errors: zodMessages(result.error) });
    }
  });

  return { valid, invalid };
}

/**
 * JSON import をパースする。
 * 入力は §10.1 のエンベロープ `{ rawSignals: [...] }` を表す **JSON 文字列** または
 * **既パース済みオブジェクト**（純粋・I/O なしのため両対応）。
 *
 * - 文字列が JSON として解釈できない → 全体エラー（row=0）。
 * - `rawSignals` が配列でない → 全体エラー（row=0）。
 * - 各要素は 1 件ずつ検証し、不正なものだけ invalid（row = 1 始まりの配列位置）に残す。
 */
export function parseJson(input: string | unknown): ParseResult {
  let payload: unknown = input;

  if (typeof input === "string") {
    try {
      payload = JSON.parse(input);
    } catch (error) {
      return {
        valid: [],
        invalid: [{ row: 0, errors: [`JSON として解釈できません: ${(error as Error).message}`] }],
      };
    }
  }

  const envelope = importEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    return { valid: [], invalid: [{ row: 0, errors: zodMessages(envelope.error) }] };
  }

  // JSON は配列位置を 1 始まりの行番号として用いる。
  return validateRows(envelope.data.rawSignals, (index) => index + 1);
}

/**
 * RFC4180 風の最小 CSV トークナイザ（純粋）。引用符（`"`）で囲んだフィールド内の
 * カンマ・改行・二重引用符（`""` エスケープ）を解釈する。依存追加はしない（zod のみ方針）。
 * 末尾改行は空行として残さない。
 */
function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1; // エスケープされた二重引用符
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      fieldStarted = true;
    } else if (char === ",") {
      endField();
      fieldStarted = true;
    } else if (char === "\n") {
      endRow();
    } else if (char === "\r") {
      // CRLF の CR は無視（次の \n で行確定）。
    } else {
      field += char;
      fieldStarted = true;
    }
  }

  // 末尾に未確定の行が残っていれば確定（末尾改行のみの空行は対象外）。
  if (fieldStarted || field.length > 0 || row.length > 0) {
    endRow();
  }

  return rows;
}

/**
 * CSV の 1 データ行（列値の配列）を、ヘッダに従って import 形オブジェクトへ変換する。
 * - `tags` 列はセミコロン区切り → 文字列配列（前後空白除去・空要素除去）。
 * - 数値列（observedRating / observedReviews）は Number 化（失敗時は生値のまま渡し Zod に
 *   400 を出させる）。
 * - 空セルはキーごと省略（optional フィールドの既定を尊重し、空文字での検証失敗を避ける）。
 * - ヘッダに無い/未知の列はスキーマ側で strip される。
 */
function csvRowToObject(header: string[], cols: string[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};

  header.forEach((key, index) => {
    const cell = (cols[index] ?? "").trim();

    if (key === "tags") {
      obj.tags =
        cell === ""
          ? []
          : cell
              .split(CSV_TAGS_DELIMITER)
              .map((tag) => tag.trim())
              .filter((tag) => tag.length > 0);
      return;
    }

    if (cell === "") {
      return; // 空セルは未指定（省略）。
    }

    if (NUMERIC_CSV_COLUMNS.has(key)) {
      const num = Number(cell);
      obj[key] = Number.isNaN(num) ? cell : num;
      return;
    }

    obj[key] = cell;
  });

  return obj;
}

/**
 * 固定ヘッダ CSV import をパースする（§10.1）。1 行目をヘッダとして列名を解決し、
 * 2 行目以降を 1 件ずつ検証する。`tags` はセミコロン区切り → 配列。
 *
 * - 空入力（ヘッダすら無い）→ 全体エラー（row=0）。
 * - 不正行は invalid に残す（row = ファイル行番号。ヘッダが 1 行目なのでデータは 2 行目から）。
 */
export function parseCsv(input: string): ParseResult {
  const records = tokenizeCsv(input);
  if (records.length === 0) {
    return { valid: [], invalid: [{ row: 0, errors: ["CSV が空です"] }] };
  }

  const header = records[0].map((name) => name.trim());
  const dataRows = records.slice(1);
  const objects = dataRows.map((cols) => csvRowToObject(header, cols));

  // CSV はヘッダが 1 行目。データ行 index 0 はファイル 2 行目。
  return validateRows(objects, (index) => index + 2);
}
