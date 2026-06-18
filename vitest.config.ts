import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}", "lib/**/*.test.{ts,tsx}"],
    globals: true,
    // 改善① Phase2 指摘②（CIフレーク恒久対策）: DB 統合テスト（26 ファイル）は beforeAll で
    // `prisma db push` を execSync する。各ファイルは独立した一時 SQLite を使う（データ競合は無い）が、
    // ファイル並列実行だと prisma CLI プロセスが同時多発し、IO/エンジンの競合で db push が
    // beforeAll の既定 10s を超えて偽陽性 fail し得た（--no-file-parallelism は手動回避にすぎない）。
    // ファイル並列を恒久的に無効化し db push を直列化することで、追加フラグ無しの通常 `pnpm test`
    // （CI が叩くコマンド）が安定 green になる。純粋/UI テストは ms オーダーのため直列でも実害は小さい。
    fileParallelism: false,
  },
});
