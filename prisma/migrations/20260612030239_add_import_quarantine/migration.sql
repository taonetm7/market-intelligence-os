-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "origin" TEXT NOT NULL DEFAULT 'import',
    "format" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "QuarantineRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payloadJson" TEXT,
    "errorsJson" TEXT,
    "rawSignalId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QuarantineRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ImportBatch_createdAt_idx" ON "ImportBatch"("createdAt");

-- CreateIndex
CREATE INDEX "QuarantineRow_batchId_idx" ON "QuarantineRow"("batchId");

-- CreateIndex
CREATE INDEX "QuarantineRow_status_idx" ON "QuarantineRow"("status");
