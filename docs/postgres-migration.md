# SQLite → PostgreSQL 移行ガイド（task-40 / spec v2 §6.3, §18.7）

## これは何か / いつ使うか

market-intelligence-os の既定 DB は **SQLite**（`prisma/schema.prisma` / `file:./dev.db`）です。
ローカルで 1 人で使い続けるなら **SQLite のままで何も変える必要はありません**。

この移行は「**Web 公開／チーム利用に踏み切ると決めたとき**」のための準備です。本番ホスティング・
認証・マルチユーザーは依然スコープ外（別判断・GATE 相当）で、ここでは「**Postgres でも動かせる状態**」
までを用意します。既存の SQLite データ・スキーマは壊しません（変更は追加的・非破壊）。

## 仕組み（なぜ schema ファイルが 2 つあるか）

Prisma は datasource の `provider` に `env()` を使えません（`P1012: A datasource must not use the env()
function in the provider argument`）。そのため provider 切替は **どちらの schema ファイルで Prisma を
動かすか** で表現します。

| provider | schema ファイル | 用途 |
| --- | --- | --- |
| `sqlite`（既定） | `prisma/schema.prisma` | 通常のローカル利用・CI。env 未設定時はこちら。 |
| `postgresql` | `prisma/schema.postgres.prisma` | Postgres で動かす／移行するとき。 |

2 つの schema は **datasource の `provider` 行だけが異なり、モデル定義は完全に一致** させています。
これは全件 JSON export→import（`scripts/export-all` / `import-all`）が **provider 間で無変換のまま
往復一致** するための設計です。`enum` 化・`jsonb` 化は **あえて行いません**（破壊的変更になり、
往復互換も崩れるため）。「enum 相当」は引き続き `String` 列 + アプリ層の Zod 検証（task-02）で担保します。

切替の入口は環境変数 **`DATABASE_PROVIDER`**：

- 未設定／`sqlite` → SQLite（現状動作）。
- `postgres` / `postgresql` → 全文検索が Postgres 実装（`pg_trgm`）に分岐し（`lib/db/search.ts`）、
  Prisma コマンドは `--schema prisma/schema.postgres.prisma` を使う。

## 1. ローカル Postgres を起動

```bash
docker compose up -d           # postgres:16-alpine を起動
docker compose ps              # healthy になるまで待つ
```

接続文字列（docker-compose.yml の既定）:

```
postgresql://mi:mi@localhost:5432/market_intel?schema=public
```

`.env`（コミットしない）に設定する例 — `.env.example` のコメント参照:

```
DATABASE_PROVIDER=postgres
DATABASE_URL="postgresql://mi:mi@localhost:5432/market_intel?schema=public"
```

## 2. 既存 SQLite データを書き出す（移行する場合）

**まだ DATABASE_PROVIDER を切り替える前に**、現行 SQLite から全件 export します（既定クライアントのまま）:

```bash
pnpm export-all exports/migrate.json
```

## 3. Postgres 用にクライアント生成 & スキーマ作成

```bash
export DATABASE_PROVIDER=postgres
export DATABASE_URL="postgresql://mi:mi@localhost:5432/market_intel?schema=public"

pnpm exec prisma generate --schema prisma/schema.postgres.prisma
pnpm exec prisma db push  --schema prisma/schema.postgres.prisma
```

> `prisma generate` は provider 固有のクライアントを生成します。SQLite に戻すときは
> `pnpm exec prisma generate`（既定 schema）で再生成してください。

## 4. データを取り込む（移行する場合）

step 2 のバンドルを Postgres へ取り込みます。取り込み後に **全文検索索引（pg_trgm）を作成**し、
**往復一致（総件数）を検証**します:

```bash
DATABASE_PROVIDER=postgres DATABASE_URL="postgresql://mi:mi@localhost:5432/market_intel?schema=public" \
  node --env-file-if-exists=.env \
       --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
       --disable-warning=ExperimentalWarning \
       --experimental-transform-types \
       scripts/migrate-sqlite-to-pg.ts exports/migrate.json
```

- 内部では既存機構をそのまま流用します:
  `import-all`（原子的・auto-snapshot 付きの復元）→ `ensureSearchIndex`（pg_trgm 索引）→
  `export-all` で再読込し総件数を突合（`往復一致: OK`）。
- 取り込み先が Postgres でない場合（`DATABASE_PROVIDER` / `DATABASE_URL` 不整合）は、SQLite を
  誤って上書きしないよう**中断**します。

## 5. 全文検索について（SQLite FTS5 ↔ Postgres pg_trgm）

`lib/db/search.ts` の公開インターフェース（`searchRawSignalIds` / `search` / `toMatchQuery` /
`ensureSearchIndex` / `reindexAll`）は **provider に依らず不変**です。内部だけが分岐します:

| | SQLite（既定） | Postgres |
| --- | --- | --- |
| 実装 | FTS5 仮想テーブル + 同期トリガ | `pg_trgm` 拡張 + GIN trigram 索引 + `ILIKE` |
| 索引同期 | INSERT/UPDATE/DELETE トリガ | 索引が行更新へ自動追随（トリガ不要） |
| CJK 部分一致 | trigram tokenizer | trigram（`ILIKE '%q%'`） |

Postgres でも **`tsvector`/`to_tsquery` は使いません**。日本語など語境界の無い言語を既定の
text search 設定では分割できず、FTS5 trigram と同じ「含む」一致が崩れるためです。`pg_trgm` の
trigram 索引 + `ILIKE` が FTS5 trigram と同じ意味論（CJK でも部分一致・3 文字以上想定）を保ちます。

索引は `ensureSearchIndex()`（移行スクリプトが呼ぶ）で冪等に作成されます。手動なら:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "RawSignal_rawText_trgm_idx"        ON "RawSignal" USING gin ("rawText" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "RawSignal_observedEntity_trgm_idx" ON "RawSignal" USING gin ("observedEntity" gin_trgm_ops);
```

## 6. 動作確認（スモークテスト）

Postgres を起動し `DATABASE_PROVIDER=postgres` を設定した状態でのみ走るスモークがあります。
**未設定の通常 CI ではスキップ**され、既存テスト群（SQLite）は全 green を維持します。

```bash
export DATABASE_PROVIDER=postgres
export DATABASE_URL="postgresql://mi:mi@localhost:5432/market_intel?schema=public"
pnpm exec prisma generate --schema prisma/schema.postgres.prisma   # まだなら
pnpm test tests/db/pg-smoke.test.ts
```

## 7. SQLite に戻す

```bash
unset DATABASE_PROVIDER DATABASE_URL      # または .env を SQLite 設定へ戻す
pnpm exec prisma generate                 # 既定 schema（sqlite）でクライアント再生成
```

`docker compose down`（`-v` で volume ごと破棄）で Postgres を停止できます。SQLite の `dev.db` は
一切触れていないため、そのまま元の運用に戻れます。

## メンテナンス上の注意

- `prisma/schema.prisma` と `prisma/schema.postgres.prisma` は **必ず同期** すること
  （相違は datasource の `provider` 行のみ）。モデルを変更したら両方に反映する。
- `.env` / `dev.db` はコミットしない（`.gitignore` 済み）。`.env.example` のみ追従する。
