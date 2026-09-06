"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { playerExclusions } from "@/lib/db/schema";
import { normalizeUuid } from "@/lib/identity";

/**
 * Exclusion management.
 *
 * Excluding is keyed on the player, not the plot: the request is to drop a
 * holder's properties from review, and they usually hold several.
 */

function revalidateAll() {
  revalidatePath("/at-risk");
  revalidatePath("/prune");
  revalidatePath("/exclusions");
  revalidatePath("/");
}

export async function excludePlayer(
  playerUuid: string,
  reason?: string,
): Promise<void> {
  const uuid = normalizeUuid(playerUuid);
  if (!uuid) throw new Error(`Not a valid player UUID: ${playerUuid}`);

  const trimmed = reason?.trim();
  await db
    .insert(playerExclusions)
    .values({ playerUuid: uuid, reason: trimmed || null })
    .onConflictDoUpdate({
      target: playerExclusions.playerUuid,
      // Re-excluding with a new note updates it; re-excluding with none keeps
      // whatever reason was recorded the first time.
      set: { reason: sql`COALESCE(EXCLUDED.reason, ${playerExclusions.reason})` },
    });

  revalidateAll();
}

export async function includePlayer(playerUuid: string): Promise<void> {
  const uuid = normalizeUuid(playerUuid);
  if (!uuid) throw new Error(`Not a valid player UUID: ${playerUuid}`);

  await db.delete(playerExclusions).where(eq(playerExclusions.playerUuid, uuid));
  revalidateAll();
}

/** Form-action wrapper so a row's Exclude button can post a reason inline. */
export async function excludePlayerForm(formData: FormData): Promise<void> {
  const uuid = String(formData.get("playerUuid") ?? "");
  const reason = String(formData.get("reason") ?? "");
  await excludePlayer(uuid, reason);
}
