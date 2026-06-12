# Cycle 1 Runbook — 実データで1サイクル回す

Slice 1（task-00〜25）が揃った状態で、**実データを1サイクル**通すための手順メモ。
仕様正本: `market_intelligence_os_web_app_spec_v2.md` §21（MVP受け入れ基準）/ §18.4（バックアップ）。

このサイクルのゴールは「ツールを磨くこと」ではなく、**市場を1件でも検証に進めること**。
1巡してデータ管理の摩擦が実証できたら次へ。詰まったらツールではなく市場仮説に戻る。

---

## 0. 前提

- Node.js **>= 22.9.0**（`pnpm seed` / `pnpm export-all` 等が Node 同梱の TS 実行を使う）。
- 依存導入: `pnpm install`
- DB 初期化（未作成なら）: `pnpm exec prisma db push`
- `.env` に `DATABASE_URL="file:./dev.db"`（実体は `prisma/dev.db`）。

---

## 1. 初期データを入れる（seed）

```bash
pnpm seed
```

- operation 実例5件（請求書/証憑・英語学習記録・SNS投稿代行・営業リスト・インボイス）が
  Raw Signal → Candidate → Evidence → スコア/ゲートまで入る（冪等。再実行で増えない）。
- Top100 通過3件 / 不通過2件が混在し、UI が空にならない。

---

## 2. 実データを import する（quarantine → accept）

1. AI/外部出力を **JSON（`{ "rawSignals": [...] }`）** か **固定ヘッダ CSV** で用意する（§10.1）。
   - `rawText` は必須。レビューは全文転載せず**短い抜粋＋URL**（著作権・§18.2）。
   - `rawText` に PII を入れない。`origin` は import 経由なら自動で `import`（AI 由来は `ai`）。
2. アプリの **Imports 画面**で取り込む（Zod 検証 → 正常行は pending、不正行は理由付きで隔離）。
3. 隔離内容を**人間が確認**し、問題なければ **accept**（pending → 本登録）。
   - 不正行（invalid）は accept できない。直して取り込み直す。
4. 受け入れ目安: **実 import 100件**（§21 実運用テスト）。

> accept は本登録前後の RawSignal 件数を auto-snapshot として記録する（§18.4 の最小実装）。
> 大量取り込みの前には、念のため §6 のフルバックアップも取っておく。

---

## 3. Candidate を作り、Evidence を link する

1. 未紐付け（inbox）の Raw Signal を見ながら **Candidate を作成**する。
2. Raw Signal を **Evidence として link**（type / strength、**一次ソース必須**）。
   - 多面性のため、**異なる sourceType を2種以上**紐付ける（distinct sourceType ≥ 2 がゲート条件）。
   - 強シグナル（spend / dissatisfaction / search）を最低1つ含める。

---

## 4. スコアとゲートで抽出する

- **InitialScore**（市場デマンドのみ・config重み）は素点から自動計算される（§8.1）。
- **Top100 ゲート**で抽出: `score≥58 ∧ distinct sourceType≥2 ∧ 強シグナル≥1 ∧ legal/opsRisk≤3`（§8.2）。
- 通過した候補から **30件を hand-pick** する（§21）。
- 進めない候補は**棄却理由コード（enum）付きで棄却**する（あとで分布を集計し、何で落ちがちか学ぶ）。

### 重み・閾値を調整したくなったら

- `config/scoring.config.json` を編集する（重み・ゲート閾値）。
- 変更したら **`version` を手で上げる**（例 `2026.06-v1` → `2026.07-v1`・§8.10）。
- 変更はスコア計算に反映される（再起動で再ロード）。過去スコアの解釈用に version を残す。

---

## 5. 1件を Deep Research 用に export する

- hand-pick した有望候補を1件、外部リサーチに回すためにエクスポートする（§21）。
- Slice 1 時点では全件 export（§6）で代用可。1件単位の Deep Research export は Slice 3（task-32）。

---

## 6. バックアップ / 復元（§18.4）

### 全件 JSON export（git 管理する）

```bash
pnpm export-all                 # exports/export-<timestamp>.json に全件書き出し
pnpm export-all path/to/out.json
```

- コア5テーブル＋運用テーブル（ImportBatch / QuarantineRow）を1ファイルに。
- `exports/` は git 管理してよい（PII を含めないこと）。

### 全件 JSON import（復元）

```bash
pnpm import-all exports/export-<timestamp>.json
```

- **破壊的**: 取り込み前に既存全件を消してバンドルの状態へ復元する（冪等）。
- **原子的**: 全削除 → 再投入は 1 つのトランザクションで実行する。不整合バンドル
  （FK 違反・重複 id・必須欠落 等）で途中失敗しても丸ごとロールバックされ、**元データは
  無傷で残る**（DB が空 / 部分復元のまま壊れることはない）。失敗時はエラーを表示して中断する。
- 取り込み前の総件数を auto-snapshot として表示する。
- `export → import → export` で全件が往復一致する（id・タイムスタンプ含む）。

> 失敗時の復旧: import-all は原子的なので、失敗してもそのまま再試行できる（元データは残る）。
> バンドル自体が壊れている場合は、直近の健全な export か `pnpm backup-db` のスナップショットへ戻す。

### DB ファイルのスナップショット（最速の保険）

```bash
pnpm backup-db                  # backups/dev-<timestamp>.db に DB ファイルをコピー
pnpm backup-db path/to/snap.db
```

- SQLite ファイルをそのままコピーするだけ。`*.db` は `.gitignore` 対象（コミットしない）。
- **bulk import / merge の前**に取っておくと、事故時にファイルを差し替えるだけで戻せる。
- 週次でも取る（§18.4: 週次バックアップ）。

---

## 7. 一巡の受け入れチェック（§21）

```text
□ Raw Signal を Quick Capture（4項目）で 60〜120秒以内に登録できた
□ JSON/CSV で Raw Signal を一括 import できた（Zod検証＋不正行は隔離）
□ Candidate を作成できた
□ 未紐付け Raw Signal を Candidate に Evidence として link できた（type/strength・一次ソース必須）
□ InitialScore（市場デマンドのみ・config重み）が自動計算された
□ Top100ゲートで抽出できた（score≥58 ∧ distinct sourceType≥2 ∧ 強シグナル≥1 ∧ legal/opsRisk≤3）
□ 棄却を理由コード(enum)付きで残せた（分布を集計できる）
□ 全行に origin（manual/import/ai）が付いている
□ scoring.config.json で重み・閾値を変更し、スコアに反映された
□ 全件 export → import で往復一致した／DB スナップショットを取れた
```

実運用テスト（§21）: **seed(5例) ＋ 実import 100件 → Top100抽出 → 30件をhand-pick →
棄却理由コードの分布を集計 → Deep Research用に1件export**。

---

## 困ったら

- import で全行 invalid → ヘッダ/必須（`rawText`・`sourceType` の enum）を疑う。
- スコアが想定と違う → `config/scoring.config.json` の重みと、素点（initialInputs）を確認。
- 取り込みで壊した気がする → まず `pnpm backup-db` した直近スナップショット、なければ
  直近の `pnpm export-all` バンドルから `pnpm import-all` で戻す。
- **ツールをいじりたくなったら手を止める。** このサイクルの目的は市場検証であって、
  メタツールの作り込みではない（§23 No-Go）。
