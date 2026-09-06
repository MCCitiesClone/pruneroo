"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { playerRealtors } from "@/lib/db/schema";
import { normalizeUuid } from "@/lib/identity";

/**
 * Realtor marking.
 *
 * Operator state, like exclusions: the realtor job cannot be read from any API,
 * so someone runs `/about <player>` in game and records the answer here. It
 * changes what counts as a violation — §17(9) adds 5 to the commercial,
 * residential, industrial and skyscraper limits — so it is deliberately an
 * explicit act rather than something inferred from holdings.
 */

function revalidateAll(playerUuid: string) {
  revalidatePath(`/players/${playerUuid}`);
  revalidatePath("/at-risk");
  revalidatePath("/");
}

export async function markRealtor(
  playerUuid: string,
  note?: string,
): Promise<void> {
  const uuid = normalizeUuid(playerUuid);
  if (!uuid) throw new Error(`Not a valid player UUID: ${playerUuid}`);

  const trimmed = note?.trim();
  await db
    .insert(playerRealtors)
    .values({ playerUuid: uuid, note: trimmed || null })
    .onConflictDoUpdate({
      target: playerRealtors.playerUuid,
      // Re-marking with a new note updates it; re-marking with none keeps the
      // note recorded the first time.
      set: { note: sql`COALESCE(EXCLUDED.note, ${playerRealtors.note})` },
    });

  revalidateAll(uuid);
}

export async function unmarkRealtor(playerUuid: string): Promise<void> {
  const uuid = normalizeUuid(playerUuid);
  if (!uuid) throw new Error(`Not a valid player UUID: ${playerUuid}`);

  await db.delete(playerRealtors).where(eq(playerRealtors.playerUuid, uuid));
  revalidateAll(uuid);
}

/** Form-action wrapper so the note can be posted inline with the button. */
export async function markRealtorForm(formData: FormData): Promise<void> {
  const uuid = String(formData.get("playerUuid") ?? "");
  const note = String(formData.get("note") ?? "");
  await markRealtor(uuid, note);
}
