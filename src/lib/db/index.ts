import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getEnv } from "@/lib/env";
import * as schema from "./schema";

/**
 * A single pool per process. Next's dev server re-evaluates modules on HMR, so
 * the pool is stashed on globalThis to avoid leaking connections.
 */
const globalForDb = globalThis as unknown as {
  __prunerooPool?: Pool;
};

function getPool(): Pool {
  if (!globalForDb.__prunerooPool) {
    globalForDb.__prunerooPool = new Pool({
      connectionString: getEnv().DATABASE_URL,
      max: 10,
    });
  }
  return globalForDb.__prunerooPool;
}

export const db = drizzle(getPool(), { schema });
export { schema };
export type Db = typeof db;
