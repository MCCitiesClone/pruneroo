import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { players } from "@/lib/db/schema";
import { normalizeName, normalizeUuid } from "@/lib/identity";

export interface PlayerRefLike {
  id?: string | null;
  uuid?: string | null;
  name?: string | null;
}

/**
 * Upsert players discovered anywhere in the pipeline.
 *
 * Every source hands us player identities as a side effect of its own data, so
 * this is the one place the `players` dimension grows. Names are refreshed only
 * when non-null: Realty returns `name: null` whenever its query-service module
 * is down, and that must not wipe a name we already know.
 */
export async function upsertPlayers(
  refs: Array<PlayerRefLike | null | undefined>,
): Promise<number> {
  const seen = new Map<string, string | null>();

  for (const ref of refs) {
    if (!ref) continue;
    const uuid = normalizeUuid(ref.id ?? ref.uuid);
    if (!uuid) continue;
    const name = normalizeName(ref.name);
    // A later non-null name wins over an earlier null within the same batch.
    if (!seen.has(uuid) || (name && !seen.get(uuid))) {
      seen.set(uuid, name);
    }
  }

  if (seen.size === 0) return 0;

  // Sorted by uuid so every concurrent upsert takes row locks in the same
  // order. Without this, two handlers inserting overlapping players in
  // different orders deadlock — observed between the Realty region-detail and
  // Treasury chest-shop crawls once sources began running in parallel.
  const rows = [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([uuid, name]) => ({
      uuid,
      name,
      nameLower: name ? name.toLowerCase() : null,
      updatedAt: new Date(),
    }));

  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(players)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: players.uuid,
        set: {
          name: sql`COALESCE(EXCLUDED.name, ${players.name})`,
          nameLower: sql`COALESCE(EXCLUDED.name_lower, ${players.nameLower})`,
          updatedAt: new Date(),
        },
      });
  }

  return rows.length;
}
