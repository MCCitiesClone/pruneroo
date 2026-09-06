import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { treasuryBalances } from "@/lib/db/schema";
import { parseMoney } from "@/lib/sources/treasury/client";

/**
 * Storing Treasury balances.
 *
 * Shared by every sweep that reads a balance, so the money-handling rule lives
 * in one place: the decimal string from upstream is validated and handed to
 * Postgres `numeric` untouched, never routed through a JS number.
 *
 * `/prune` deliberately does *not* call anything here at render time. It reads
 * whatever the sweeps have stored; see the note in `src/app/prune/page.tsx`.
 */

/** Upsert one balance. Money stays a decimal string; Postgres numeric holds it. */
export async function writeBalance(
  accountId: number,
  rawBalance: string | null | undefined,
): Promise<void> {
  const money = parseMoney(rawBalance);
  await db
    .insert(treasuryBalances)
    .values({
      accountId,
      balance: money.numeric,
      balanceRaw: money.raw,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: treasuryBalances.accountId,
      set: {
        balance: sql`EXCLUDED.balance`,
        balanceRaw: sql`EXCLUDED.balance_raw`,
        syncedAt: new Date(),
      },
    });
}
