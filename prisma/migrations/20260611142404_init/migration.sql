-- CreateTable
CREATE TABLE "RawSignal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayId" TEXT NOT NULL,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceType" TEXT NOT NULL,
    "sourceName" TEXT,
    "sourceUrl" TEXT,
    "country" TEXT,
    "language" TEXT,
    "rawText" TEXT NOT NULL,
    "observedEntity" TEXT,
    "observedPrice" TEXT,
    "observedRank" TEXT,
    "observedRating" REAL,
    "observedReviews" INTEGER,
    "observedUpdate" DATETIME,
    "signalTagsJson" TEXT DEFAULT '[]',
    "extraJson" TEXT DEFAULT '{}',
    "note" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'inbox',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayId" TEXT NOT NULL,
    "problemFamily" TEXT,
    "title" TEXT NOT NULL,
    "targetUser" TEXT,
    "contextTrigger" TEXT,
    "painStatement" TEXT,
    "currentSubstitute" TEXT,
    "spendType" TEXT,
    "monetizationGuess" TEXT,
    "productFormFitJson" TEXT DEFAULT '[]',
    "initialInputsJson" TEXT DEFAULT '{}',
    "detailedInputsJson" TEXT DEFAULT '{}',
    "founderFit" INTEGER,
    "buildEase" INTEGER,
    "legalRisk" INTEGER,
    "opsRisk" INTEGER,
    "initialScore" REAL,
    "detailedScore" REAL,
    "signalBonus" REAL,
    "uncertaintyPenalty" REAL,
    "confidence" REAL,
    "scoreConfigVersion" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'normalized',
    "testableWithinDays" INTEGER,
    "testMethod" TEXT,
    "nextAction" TEXT,
    "rejectedReason" TEXT,
    "rejectedReasonCode" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "rawSignalId" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "strength" INTEGER NOT NULL,
    "credibility" INTEGER NOT NULL DEFAULT 3,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Evidence_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Evidence_rawSignalId_fkey" FOREIGN KEY ("rawSignalId") REFERENCES "RawSignal" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScoreSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "snapshotAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "initialScore" REAL,
    "detailedScore" REAL,
    "signalBonus" REAL,
    "uncertaintyPenalty" REAL,
    "confidence" REAL,
    "configVersion" TEXT,
    "reason" TEXT,
    CONSTRAINT "ScoreSnapshot_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DecisionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "decisionType" TEXT NOT NULL,
    "fromStage" TEXT,
    "toStage" TEXT,
    "relatedCandidateId" TEXT,
    "reason" TEXT NOT NULL,
    "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionLog_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "RawSignal_displayId_key" ON "RawSignal"("displayId");

-- CreateIndex
CREATE INDEX "RawSignal_sourceType_idx" ON "RawSignal"("sourceType");

-- CreateIndex
CREATE INDEX "RawSignal_status_idx" ON "RawSignal"("status");

-- CreateIndex
CREATE INDEX "RawSignal_observedEntity_idx" ON "RawSignal"("observedEntity");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_displayId_key" ON "Candidate"("displayId");

-- CreateIndex
CREATE INDEX "Candidate_stage_idx" ON "Candidate"("stage");

-- CreateIndex
CREATE INDEX "Candidate_rejectedReasonCode_idx" ON "Candidate"("rejectedReasonCode");

-- CreateIndex
CREATE INDEX "Evidence_candidateId_idx" ON "Evidence"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "Evidence_candidateId_rawSignalId_evidenceType_key" ON "Evidence"("candidateId", "rawSignalId", "evidenceType");

-- CreateIndex
CREATE INDEX "ScoreSnapshot_candidateId_idx" ON "ScoreSnapshot"("candidateId");

-- CreateIndex
CREATE INDEX "DecisionLog_candidateId_idx" ON "DecisionLog"("candidateId");
