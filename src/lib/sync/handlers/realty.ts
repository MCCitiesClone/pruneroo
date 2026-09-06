import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  realtyActivity,
  regionAuctions,
  regionFreehold,
  regionLeasehold,
  regions,
  worlds,
} from "@/lib/db/schema";
import { dedupeBy } from "@/lib/db/dedupe";
import { normalizeUuid } from "@/lib/identity";
import { classifyPlot } from "@/lib/plots/categories";
import { getSources } from "@/lib/sources";
import {
  MAX_PAGE_SIZE,
  activityDedupeHash,
} from "@/lib/sources/realty/client";
import type { ActivityEvent, RegionDetail } from "@/lib/sources/realty/schemas";

import { enqueue, enqueueMany, getWatermark, setWatermark, startRun } from "../queue";
import { upsertPlayers } from "../players";

const SOURCE = "realty";

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Realty prices arrive as JSON numbers; Postgres numeric stores them exactly. */
function toNumeric(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return value.toString();
}

async function upsertWorlds(
  refs: Array<{ id: string; name?: string | null } | null | undefined>,
): Promise<void> {
  const seen = new Map<string, string | null>();
  for (const ref of refs) {
    if (!ref) continue;
    const uuid = normalizeUuid(ref.id);
    if (!uuid) continue;
    if (!seen.has(uuid) || (ref.name && !seen.get(uuid))) {
      seen.set(uuid, ref.name ?? null);
    }
  }
  if (seen.size === 0) return;

  await db
    .insert(worlds)
    .values([...seen].map(([uuid, name]) => ({ uuid, name })))
    .onConflictDoUpdate({
      target: worlds.uuid,
      set: {
        name: sql`COALESCE(EXCLUDED.name, ${worlds.name})`,
        syncedAt: new Date(),
      },
    });
}

/**
 * O(1) change probe for the region set.
 *
 * The activity feed reports contract events but never region *registration*,
 * so `/v1/stats.regions` is the only way to notice a region appearing or
 * disappearing. One request, and it gates the 79-page index crawl.
 */
export async function handleRealtyStats(): Promise<void> {
  const run = await startRun(SOURCE, "realty.stats");
  const { realty } = getSources();

  try {
    const stats = await realty.stats();
    const count = stats?.regions ?? null;
    const previous = (await getWatermark(SOURCE, "stats.regions"))?.cursorInt ?? null;

    if (count !== null && count !== previous) {
      // Watermark is committed by the index job on success, not here — see the
      // note in handlers/punishments.ts. Advancing it early turns an
      // interrupted crawl into a permanent silent gap.
      await enqueue({
        source: SOURCE,
        kind: "realty.regions.index",
        dedupeKey: "realty.regions.index",
        payload: { count },
        priority: 30,
      });
      await run.finish({
        status: "ok",
        requestsMade: 1,
        note: `Region count ${previous ?? "none"} -> ${count}; index enqueued`,
      });
      return;
    }

    await run.finish({
      status: "ok",
      requestsMade: 1,
      note: `Region count unchanged at ${count}; no crawl enqueued`,
    });
  } catch (error) {
    await run.finish({
      status: "error",
      requestsMade: 1,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Page the region index. Entries are identity + state only — confirmed against
 * the live API — so this discovers the region set and enqueues a detail fetch
 * for anything whose full state we have never retrieved.
 */
export async function handleRealtyRegionsIndex(payload?: {
  count?: number;
}): Promise<void> {
  const run = await startRun(SOURCE, "realty.regions.index");
  const { realty } = getSources();

  let requests = 0;
  let upserted = 0;
  const detailJobs: Array<{ worldUuid: string; wgRegionId: string }> = [];

  try {
    let page = 1;
    let totalPages = 1;

    do {
      const result = await realty.regionPage(page, MAX_PAGE_SIZE);
      requests += 1;
      if (!result) break;

      totalPages = result.totalPages;
      await upsertWorlds(result.regions.map((r) => r.world));

      const rows = dedupeBy(result.regions, (e) => `${e.world.id}:${e.worldGuardRegionId}`)
        .map((entry) => {
          const worldUuid = normalizeUuid(entry.world.id);
          if (!worldUuid) return null;
          return {
            worldUuid,
            wgRegionId: entry.worldGuardRegionId,
            state: entry.state ?? null,
            // The index carries no tags; detail fills zoning in properly.
            category: undefined,
            lastSeenAt: new Date(),
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (rows.length > 0) {
        const inserted = await db
          .insert(regions)
          .values(rows)
          .onConflictDoUpdate({
            target: [regions.worldUuid, regions.wgRegionId],
            set: { state: sql`EXCLUDED.state`, lastSeenAt: new Date() },
          })
          .returning({
            worldUuid: regions.worldUuid,
            wgRegionId: regions.wgRegionId,
            detailFetchedAt: regions.detailFetchedAt,
          });

        upserted += rows.length;
        for (const row of inserted) {
          if (row.detailFetchedAt === null) {
            detailJobs.push({
              worldUuid: row.worldUuid,
              wgRegionId: row.wgRegionId,
            });
          }
        }
      }

      page += 1;
    } while (page <= totalPages);

    // Backfill detail for regions we have never fully fetched. In steady state
    // this is empty and the activity feed drives refreshes instead.
    await enqueueMany(
      detailJobs.map((job) => ({
        source: SOURCE,
        kind: "realty.region.detail",
        dedupeKey: `${job.worldUuid}:${job.wgRegionId}`,
        payload: job,
        priority: 150,
      })),
    );

    if (typeof payload?.count === "number") {
      await setWatermark(SOURCE, "stats.regions", { cursorInt: payload.count });
    }

    await run.finish({
      status: "ok",
      requestsMade: requests,
      itemsUpserted: upserted,
      note: `Indexed ${upserted} regions; enqueued ${detailJobs.length} detail fetches`,
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

async function persistRegionDetail(detail: RegionDetail): Promise<void> {
  const worldUuid = normalizeUuid(detail.world.id);
  if (!worldUuid) return;
  const wgRegionId = detail.worldGuardRegionId;

  await upsertWorlds([detail.world]);
  await upsertPlayers([
    detail.freehold?.titleHolder,
    detail.freehold?.authority,
    detail.leasehold?.landlord,
    detail.leasehold?.tenant,
    detail.auction?.auctioneer,
    detail.auction?.highestBid?.bidder,
  ]);

  const contractType = detail.freehold
    ? "freehold"
    : detail.leasehold
      ? "leasehold"
      : null;

  await db
    .insert(regions)
    .values({
      worldUuid,
      wgRegionId,
      state: detail.state ?? null,
      contractType,
      ...(() => {
        const c = classifyPlot(wgRegionId, detail.tags ?? []);
        return { category: c.category, area: c.area, categorySource: c.source };
      })(),
      tags: detail.tags ?? [],
      dimensions: detail.dimensions ?? null,
      detailFetchedAt: new Date(),
      lastSeenAt: new Date(),
      raw: detail,
    })
    .onConflictDoUpdate({
      target: [regions.worldUuid, regions.wgRegionId],
      set: {
        state: sql`EXCLUDED.state`,
        contractType: sql`EXCLUDED.contract_type`,
        category: sql`EXCLUDED.category`,
        area: sql`EXCLUDED.area`,
        categorySource: sql`EXCLUDED.category_source`,
        tags: sql`EXCLUDED.tags`,
        // Dimensions go null when Realty's query module is down; keep the old
        // value rather than destroying good data on a transient outage.
        dimensions: sql`COALESCE(EXCLUDED.dimensions, ${regions.dimensions})`,
        detailFetchedAt: new Date(),
        lastSeenAt: new Date(),
        raw: sql`EXCLUDED.raw`,
      },
    });

  // Contracts are mutually exclusive per region, and a region can lose one.
  if (detail.freehold) {
    await db
      .insert(regionFreehold)
      .values({
        worldUuid,
        wgRegionId,
        titleholderUuid: normalizeUuid(detail.freehold.titleHolder?.id),
        authorityUuid: normalizeUuid(detail.freehold.authority?.id),
        price: toNumeric(detail.freehold.price),
        lastSoldPrice: toNumeric(detail.freehold.lastSoldPrice),
        acceptingOffers: detail.freehold.acceptingOffers ?? null,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [regionFreehold.worldUuid, regionFreehold.wgRegionId],
        set: {
          titleholderUuid: sql`EXCLUDED.titleholder_uuid`,
          authorityUuid: sql`EXCLUDED.authority_uuid`,
          price: sql`EXCLUDED.price`,
          lastSoldPrice: sql`EXCLUDED.last_sold_price`,
          acceptingOffers: sql`EXCLUDED.accepting_offers`,
          syncedAt: new Date(),
        },
      });
  } else {
    await db.execute(sql`
      DELETE FROM region_freehold
      WHERE world_uuid = ${worldUuid} AND wg_region_id = ${wgRegionId}
    `);
  }

  if (detail.leasehold) {
    await db
      .insert(regionLeasehold)
      .values({
        worldUuid,
        wgRegionId,
        landlordUuid: normalizeUuid(detail.leasehold.landlord?.id),
        tenantUuid: normalizeUuid(detail.leasehold.tenant?.id),
        price: toNumeric(detail.leasehold.price),
        durationSeconds: detail.leasehold.durationSeconds ?? null,
        startAt: toDate(detail.leasehold.startDate),
        endAt: toDate(detail.leasehold.endDate),
        extensionsUsed: detail.leasehold.extensionsUsed ?? null,
        maxExtensions: detail.leasehold.maxExtensions ?? null,
        terminationEffectiveAt: toDate(detail.leasehold.terminationEffectiveDate),
        terminatedByRole: detail.leasehold.terminatedByRole ?? null,
        acceptingTenants: detail.leasehold.acceptingTenants ?? null,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [regionLeasehold.worldUuid, regionLeasehold.wgRegionId],
        set: {
          landlordUuid: sql`EXCLUDED.landlord_uuid`,
          tenantUuid: sql`EXCLUDED.tenant_uuid`,
          price: sql`EXCLUDED.price`,
          durationSeconds: sql`EXCLUDED.duration_seconds`,
          startAt: sql`EXCLUDED.start_at`,
          endAt: sql`EXCLUDED.end_at`,
          extensionsUsed: sql`EXCLUDED.extensions_used`,
          maxExtensions: sql`EXCLUDED.max_extensions`,
          terminationEffectiveAt: sql`EXCLUDED.termination_effective_at`,
          terminatedByRole: sql`EXCLUDED.terminated_by_role`,
          acceptingTenants: sql`EXCLUDED.accepting_tenants`,
          syncedAt: new Date(),
        },
      });
  } else {
    await db.execute(sql`
      DELETE FROM region_leasehold
      WHERE world_uuid = ${worldUuid} AND wg_region_id = ${wgRegionId}
    `);
  }

  if (detail.auction) {
    await db
      .insert(regionAuctions)
      .values({
        worldUuid,
        wgRegionId,
        auctioneerUuid: normalizeUuid(detail.auction.auctioneer?.id),
        startAt: toDate(detail.auction.startDate),
        endAt: toDate(detail.auction.endDate),
        minBid: toNumeric(detail.auction.minBid),
        minStep: toNumeric(detail.auction.minStep),
        biddingDurationSeconds: detail.auction.biddingDurationSeconds ?? null,
        paymentDurationSeconds: detail.auction.paymentDurationSeconds ?? null,
        highestBidderUuid: normalizeUuid(detail.auction.highestBid?.bidder?.id),
        highestBidAmount: toNumeric(detail.auction.highestBid?.amount),
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [regionAuctions.worldUuid, regionAuctions.wgRegionId],
        set: {
          auctioneerUuid: sql`EXCLUDED.auctioneer_uuid`,
          startAt: sql`EXCLUDED.start_at`,
          endAt: sql`EXCLUDED.end_at`,
          minBid: sql`EXCLUDED.min_bid`,
          minStep: sql`EXCLUDED.min_step`,
          highestBidderUuid: sql`EXCLUDED.highest_bidder_uuid`,
          highestBidAmount: sql`EXCLUDED.highest_bid_amount`,
          syncedAt: new Date(),
        },
      });
  } else {
    await db.execute(sql`
      DELETE FROM region_auctions
      WHERE world_uuid = ${worldUuid} AND wg_region_id = ${wgRegionId}
    `);
  }
}

export async function handleRealtyRegionDetail(payload: {
  worldUuid: string;
  wgRegionId: string;
}): Promise<void> {
  const { realty } = getSources();
  const detail = await realty.regionDetail(payload);
  if (!detail) {
    // 404: the region disappeared between indexing and this fetch.
    await db.execute(sql`
      DELETE FROM regions
      WHERE world_uuid = ${payload.worldUuid} AND wg_region_id = ${payload.wgRegionId}
    `);
    return;
  }
  await persistRegionDetail(detail);
}

/**
 * The server-wide delta feed — the primary driver of steady-state freshness.
 *
 * Every event names a region, so only regions the feed touches get a detail
 * refresh. The full explicit type list matters: the default four-event ticker
 * omits SET_TITLEHOLDER, SET_PRICE, LEASEHOLD_EXPIRY and TERMINATE, which are
 * precisely the events that invalidate cached ownership.
 */
export async function handleRealtyActivity(): Promise<void> {
  const run = await startRun(SOURCE, "realty.activity");
  const { realty } = getSources();

  const watermark = await getWatermark(SOURCE, "activity.since");
  // First run: look back a day rather than replaying 26k events.
  const since =
    watermark?.cursorTime ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

  let requests = 0;
  let ingested = 0;
  let newest: Date | null = null;
  const touched = new Map<string, { worldUuid: string; wgRegionId: string }>();

  try {
    let page = 1;
    let totalPages = 1;

    do {
      const result = await realty.activity({ since, page });
      requests += 1;
      if (!result) break;
      totalPages = result.totalPages;

      const events: ActivityEvent[] = result.events;
      if (events.length === 0) break;

      await upsertWorlds(events.map((e) => e.world));
      await upsertPlayers(
        events.flatMap((e) => [
          e.actor,
          e.buyer,
          e.tenant,
          e.landlord,
          e.agent,
          e.authority,
        ]),
      );

      const rows = events.map((event) => {
        const eventTime = toDate(event.eventTime) ?? new Date();
        if (!newest || eventTime > newest) newest = eventTime;
        const worldUuid = normalizeUuid(event.world?.id);
        if (worldUuid && event.worldGuardRegionId) {
          touched.set(`${worldUuid}:${event.worldGuardRegionId}`, {
            worldUuid,
            wgRegionId: event.worldGuardRegionId,
          });
        }
        return {
          dedupeHash: activityDedupeHash(event),
          eventTime,
          kind: event.kind,
          eventType: event.eventType,
          worldUuid,
          wgRegionId: event.worldGuardRegionId ?? null,
          actorUuid: normalizeUuid(event.actor?.id),
          buyerUuid: normalizeUuid(event.buyer?.id),
          tenantUuid: normalizeUuid(event.tenant?.id),
          landlordUuid: normalizeUuid(event.landlord?.id),
          agentUuid: normalizeUuid(event.agent?.id),
          authorityUuid: normalizeUuid(event.authority?.id),
          price: toNumeric(event.price),
          durationSeconds: event.durationSeconds ?? null,
          raw: event,
        };
      });

      // Events carry no upstream id, so the content hash makes this idempotent.
      await db.insert(realtyActivity).values(rows).onConflictDoNothing();
      ingested += rows.length;

      page += 1;
    } while (page <= totalPages);

    await enqueueMany(
      [...touched.values()].map((region) => ({
        source: SOURCE,
        kind: "realty.region.detail",
        dedupeKey: `${region.worldUuid}:${region.wgRegionId}`,
        payload: region,
        priority: 40,
      })),
    );

    if (newest) {
      // Re-poll from one second before the newest event: the feed's ordering
      // guarantee is per-page, and losing an event is worse than replaying one
      // (dedupeHash makes replays free).
      await setWatermark(SOURCE, "activity.since", {
        cursorTime: new Date((newest as Date).getTime() - 1000),
      });
    }

    await run.finish({
      status: "ok",
      requestsMade: requests,
      itemsUpserted: ingested,
      note: `${ingested} events since ${since.toISOString()}; ${touched.size} regions queued for refresh`,
    });
  } catch (error) {
    await run.finish({
      status: "error",
      requestsMade: requests,
      itemsUpserted: ingested,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
