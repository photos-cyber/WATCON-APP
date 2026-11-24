import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { pgAdapterConfig } from "./adapter-config";

import { Prisma } from "@/generated/prisma/client";

export { Prisma };

// Prisma's defaults (5 s per transaction, 2 s to get a connection) are too tight for a
// remote database: posting a receipt is ~35 round trips, and at ~150 ms each (India →
// Supabase Tokyo) that is > 5 s, which surfaced as "Something went wrong".
const TX_OPTIONS = {
  maxWait: Number(process.env.DB_TX_MAX_WAIT_MS ?? 10_000),
  timeout: Number(process.env.DB_TX_TIMEOUT_MS ?? 30_000),
};
/** Changes whenever client options change, so a cached dev client is rebuilt instead of reused. */
// Includes the generated models, so a cached dev client is rebuilt after `prisma generate` adds tables.
const CLIENT_KEY = `v3:${TX_OPTIONS.maxWait}:${TX_OPTIONS.timeout}:${process.env.DB_POOL_MAX ?? 10}:${Object.keys(Prisma.ModelName).sort().join(",")}`;

function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured");
  const adapter = new PrismaPg(pgAdapterConfig(connectionString, Number(process.env.DB_POOL_MAX ?? 10)));
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    transactionOptions: TX_OPTIONS,
  });
}

type Client = ReturnType<typeof createClient>;
const globalForPrisma = globalThis as unknown as { __prisma?: Client; __prismaKey?: string };

function getClient(): Client {
  // The client is cached on globalThis to survive dev hot reloads; rebuild it when the options change.
  if (!globalForPrisma.__prisma || globalForPrisma.__prismaKey !== CLIENT_KEY) {
    const old = globalForPrisma.__prisma;
    globalForPrisma.__prisma = createClient();
    globalForPrisma.__prismaKey = CLIENT_KEY;
    if (old) void old.$disconnect().catch(() => {});
  }
  return globalForPrisma.__prisma;
}

/**
 * Shared Prisma client, created lazily on first use so that importing this module
 * (e.g. during `next build`) never requires a database connection.
 */
export const db: Client = new Proxy({} as Client, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export type Db = Client;
/** Transaction client type for functions that run inside `db.$transaction`. */
export type Tx = Parameters<Parameters<Client["$transaction"]>[0]>[0];
