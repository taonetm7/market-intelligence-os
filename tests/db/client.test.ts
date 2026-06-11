import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "../../lib/db/client";

// Startup smoke test (task-01 acceptance criteria #4):
// the typed Prisma Client connects and each core model returns count 0
// against a freshly migrated, empty dev.db.
describe("prisma client startup", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("connects to the database", async () => {
    await expect(prisma.$connect()).resolves.toBeUndefined();
  });

  it("reports count 0 for every core model on an empty database", async () => {
    const [rawSignals, candidates, evidences, scoreSnapshots, decisionLogs] = await Promise.all([
      prisma.rawSignal.count(),
      prisma.candidate.count(),
      prisma.evidence.count(),
      prisma.scoreSnapshot.count(),
      prisma.decisionLog.count(),
    ]);

    expect(rawSignals).toBe(0);
    expect(candidates).toBe(0);
    expect(evidences).toBe(0);
    expect(scoreSnapshots).toBe(0);
    expect(decisionLogs).toBe(0);
  });
});
