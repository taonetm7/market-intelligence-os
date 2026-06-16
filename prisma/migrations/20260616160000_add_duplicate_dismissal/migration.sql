-- CreateTable
CREATE TABLE "DuplicateDismissal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pairKey" TEXT NOT NULL,
    "candidateAId" TEXT NOT NULL,
    "candidateBId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "dismissedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateDismissal_pairKey_key" ON "DuplicateDismissal"("pairKey");

-- CreateIndex
CREATE INDEX "DuplicateDismissal_pairKey_idx" ON "DuplicateDismissal"("pairKey");
