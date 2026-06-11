import { PrismaClient } from "@prisma/client";

// PrismaClient singleton.
// Next.js dev mode hot-reloads modules, which would otherwise spawn a new
// PrismaClient (and a new connection pool) on every reload. Cache it on the
// global object so only one instance exists per process.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
