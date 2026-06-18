-- 改善①（task-38 既知の限界①）— 棄却時刻 rejectedAt を Candidate に追加する。
-- 週次レポートの棄却理由コード分布（§15.1）の期間絞りを updatedAt 近似から rejectedAt 厳密へ移すため。
-- nullable（未棄却・移行前に棄却済みの旧データは null）。reject() が現在時刻を記録する。

-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN "rejectedAt" DATETIME;
