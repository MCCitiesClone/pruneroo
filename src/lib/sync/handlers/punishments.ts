import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { dedupeBy } from "@/lib/db/dedupe";
import { punishments } from "@/lib/db/schema";
import { getSources } from "@/lib/sources";
import type {
  NormalizedPunishment,
  PunishmentsClient,
} from "@/lib/sources/punishments/client";
import {
  PUNISHMENT_TYPES,
  type PunishmentType,
} from "@/lib/sources/punishments/schemas";

import { enqueue, getWatermark, setWatermark, startRun } from "../queue";
import { upsertPlayers } from "../players";

const SOURCE = "punishments";
const TYPES: readonly PunishmentType[] = PUNISHMENT_TYPES;

/** Safety rail so a pathological response can never spin forever. */
const MAX_PAGES = 2000;

/**
 * Stop an incremental crawl once a whole page contains nothing new. Pages are
 * newest-first (verified live), so new records are always at the front.
 */
const PAGE_SIZE_HINT = 6;

/**
 * O(1) change probe.
 *
 * `/stats/ban` and `/stats/mute` are two requests total. A crawl is enqueued
 * only when a count actually moves — nothing here runs on a timer.
 *
 * The direction of the change decides the crawl mode:
 *   count up   -> new punishments, which are at the top: incremental crawl
 *   count down -> something was deleted upstream, and only a full crawl can
 *                 find out what: full crawl with withdrawal detection
 */
export async function handlePunishmentStats(): Promise<void> {
  const run = await startRun(SOURCE, "punishments.stats");
  const { punishments: client } = getSources();
  let requests = 0;

  try {
    const changes: string[] = [];

    for (const type of TYPES) {
      const count = await client.count(type);
      requests += 1;

      const key = `count.${type.toLowerCase()}`;
      const previous = (await getWatermark(SOURCE, key))?.cursorInt ?? null;

      if (previous === count) continue;

      const mode =
        previous === null || count < previous ? "full" : "incremental";
      changes.push(`${type}: ${previous ?? "none"} -> ${count} (${mode})`);

      // The observed count travels with the job and is committed as the
      // watermark only once the crawl actually succeeds. Advancing it here
      // would mean an interrupted crawl leaves a silent, permanent gap: the
      // next probe would compare upstream against a count we never ingested
      // and conclude nothing had changed. That is exactly how 82 bans went
      // missing during development.
      await enqueue({
        source: SOURCE,
        kind: "punishments.crawl",
        dedupeKey: `punishments.crawl.${type}`,
        payload: { type, mode, count },
        priority: 20,
      });
    }

    await run.finish({
      status: "ok",
      requestsMade: requests,
      note: changes.length
        ? `Counts changed — ${changes.join("; ")}`
        : "No change; no crawl enqueued",
    });
  } catch (error) {
    await run.finish({
      status: "error",
      requestsMade: requests,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function upsertBatch(
  input: NormalizedPunishment[],
): Promise<{ inserted: number; known: number }> {
  // Upstream can serve two records that reduce to the same synthetic id, and a
  // page boundary can re-serve a row mid-crawl. Either would make Postgres
  // reject the whole ON CONFLICT DO UPDATE batch.
  const batch = dedupeBy(input, (p) => p.id);
  if (batch.length === 0) return { inserted: 0, known: 0 };

  const ids = batch.map((p) => p.id);
  const existing = await db
    .select({ id: punishments.id })
    .from(punishments)
    .where(inArray(punishments.id, ids));
  const known = new Set(existing.map((r) => r.id));

  // Victims become players so a banned account still shows up in the flags view
  // even if analytics has never seen it.
  await upsertPlayers(
    batch
      .filter((p) => p.victimUuid)
      .map((p) => ({ id: p.victimUuid, name: p.victimName })),
  );

  await db
    .insert(punishments)
    .values(
      batch.map((p) => ({
        id: p.id,
        type: p.type,
        victimRaw: p.victimRaw,
        victimKind: p.victimKind,
        victimUuid: p.victimUuid,
        victimName: p.victimName,
        operatorUuid: p.operatorUuid,
        operatorName: p.operatorName,
        reason: p.reason,
        label: p.label,
        reportedActive: p.reportedActive,
        startAt: p.startAt,
        endAt: p.endAt,
        isPermanent: p.isPermanent,
        deportationCompletedAt: p.deportationCompletedAt,
        deportationExpiresAt: p.deportationExpiresAt,
        lastSeenAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: punishments.id,
      set: {
        // A reason or label can be edited in place upstream.
        reason: sql`EXCLUDED.reason`,
        label: sql`EXCLUDED.label`,
        reportedActive: sql`EXCLUDED.reported_active`,
        endAt: sql`EXCLUDED.end_at`,
        isPermanent: sql`EXCLUDED.is_permanent`,
        deportationCompletedAt: sql`EXCLUDED.deportation_completed_at`,
        deportationExpiresAt: sql`EXCLUDED.deportation_expires_at`,
        victimName: sql`COALESCE(EXCLUDED.victim_name, ${punishments.victimName})`,
        lastSeenAt: new Date(),
        // Reappearing after a withdrawal means it was never really gone.
        withdrawnAt: null,
      },
    });

  return { inserted: batch.length - known.size, known: known.size };
}

/**
 * A full crawl always restarts at page 1 — there is no page checkpoint.
 *
 * That is a deliberate simplification, not an oversight: pages are ordered
 * newest-first and shift as records are added, so a saved page number stops
 * meaning the same thing the moment the list changes. Re-reading known pages is
 * cheap (they upsert to no-ops) and full crawls are rare — first run, or a
 * count *decrease*, which is the only signal that something was deleted.
 *
 * Note the asymmetry that makes this safe: insertions at the front can only
 * cause a record to be read twice, never skipped. Deletions can cause a skip,
 * but a deletion moves the count, which triggers a fresh full crawl anyway.
 */
export async function handlePunishmentCrawl(payload: {
  type: PunishmentType;
  mode: "full" | "incremental";
  /** Upstream count when the probe fired; becomes the watermark on success. */
  count?: number;
}): Promise<void> {
  const { type, mode, count } = payload;
  const run = await startRun(SOURCE, `punishments.crawl.${type}`);
  const client: PunishmentsClient = getSources().punishments;

  const startedAt = new Date();
  let requests = 0;
  let upserted = 0;
  let page = 1;
  let stoppedEarlyAt: number | null = null;

  try {
    for (; page <= MAX_PAGES; page += 1) {
      if (page % 50 === 0) {
        console.log(`[sync] ${type} crawl page ${page} (${upserted} rows so far)`);
      }
      const result = await client.page(type, page);
      requests += 1;
      if (!result) break;

      const { inserted, known } = await upsertBatch(result.items);
      upserted += result.items.length;

      // Incremental: once a full page is entirely familiar, everything older
      // is too, because the feed is ordered newest-first.
      if (
        mode === "incremental" &&
        inserted === 0 &&
        known >= Math.min(PAGE_SIZE_HINT, result.items.length)
      ) {
        stoppedEarlyAt = page;
        break;
      }

      if (!result.morePages) break;
    }

    let removed = 0;
    if (mode === "full") {
      // Anything not observed by a complete crawl has vanished upstream. That
      // is the only available signal for a lifted punishment — the API exposes
      // no revoked flag, and its `active` field is always false.
      const withdrawn = await db
        .update(punishments)
        .set({ withdrawnAt: new Date() })
        .where(
          and(
            eq(punishments.type, type),
            lt(punishments.lastSeenAt, startedAt),
            isNull(punishments.withdrawnAt),
          ),
        )
        .returning({ id: punishments.id });
      removed = withdrawn.length;
    }

    // Only now is it safe to say we have ingested up to this count.
    if (typeof count === "number") {
      await setWatermark(SOURCE, `count.${type.toLowerCase()}`, {
        cursorInt: count,
      });
    }

    await run.finish({
      status: "ok",
      requestsMade: requests,
      itemsUpserted: upserted,
      itemsRemoved: removed,
      note:
        stoppedEarlyAt !== null
          ? `Incremental: stopped at page ${stoppedEarlyAt} on a fully-known page`
          : `${mode} crawl over ${page} page(s)`,
    });
  } catch (error) {
    await run.finish({
      status: "error",
      requestsMade: requests,
      itemsUpserted: upserted,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
