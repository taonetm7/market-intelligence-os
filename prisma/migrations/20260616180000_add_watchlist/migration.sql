-- CreateTable
CREATE TABLE "Watchlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityType" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "locale" TEXT,
    "metricName" TEXT,
    "lastValue" TEXT,
    "currentValue" TEXT,
    "deltaFlag" TEXT NOT NULL DEFAULT 'unknown',
    "lastCheckedAt" DATETIME,
    "linkedCandidateId" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Watchlist_linkedCandidateId_fkey" FOREIGN KEY ("linkedCandidateId") REFERENCES "Candidate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Watchlist_entityType_idx" ON "Watchlist"("entityType");

-- CreateIndex
CREATE INDEX "Watchlist_linkedCandidateId_idx" ON "Watchlist"("linkedCandidateId");
