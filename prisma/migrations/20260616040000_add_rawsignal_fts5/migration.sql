-- task-33 — RawSignal 全文検索（SQLite FTS5）。spec v2 §9.3 / §18.1。
-- Prisma は FTS5 仮想テーブルをモデル化できないため raw SQL migration で定義する。
-- 仮想テーブル＋同期トリガ＋既存行の再インデックス（backfill）を作る。
-- 同じ構造を lib/db/search.ts の ensureSearchIndex が IF NOT EXISTS で冪等に張り直す
-- （`prisma db push` で用意した migration 非適用の DB 向け）。両者の構造は一致させること。
--
-- tokenizer = trigram: 日本語は語境界が無く unicode61 では部分一致が成立しないため、
-- 文字 3-gram を索引する trigram を用いる（3 文字以上のクエリで部分一致）。

-- 仮想テーブル本体。signalId は検索対象外（RawSignal.id 参照用）、rawText/observedEntity を索引する。
CREATE VIRTUAL TABLE "RawSignalFts" USING fts5(
  signalId UNINDEXED,
  rawText,
  observedEntity,
  tokenize = 'trigram'
);

-- 既存 RawSignal を索引へ取り込む（再インデックス）。observedEntity の NULL は空文字に畳む。
INSERT INTO "RawSignalFts" (signalId, rawText, observedEntity)
SELECT id, rawText, COALESCE(observedEntity, '') FROM "RawSignal";

-- INSERT/UPDATE/DELETE を FTS へ反映する同期トリガ（UPDATE は delete→insert）。
CREATE TRIGGER "RawSignalFts_ai" AFTER INSERT ON "RawSignal" BEGIN
  INSERT INTO "RawSignalFts"(signalId, rawText, observedEntity)
  VALUES (new.id, new.rawText, COALESCE(new.observedEntity, ''));
END;

CREATE TRIGGER "RawSignalFts_ad" AFTER DELETE ON "RawSignal" BEGIN
  DELETE FROM "RawSignalFts" WHERE signalId = old.id;
END;

CREATE TRIGGER "RawSignalFts_au" AFTER UPDATE ON "RawSignal" BEGIN
  DELETE FROM "RawSignalFts" WHERE signalId = old.id;
  INSERT INTO "RawSignalFts"(signalId, rawText, observedEntity)
  VALUES (new.id, new.rawText, COALESCE(new.observedEntity, ''));
END;
