import { createHash } from "node:crypto";

import type { ApiClient } from "@/lib/http/client";

import {
  ALL_ACTIVITY_TYPES,
  activitySchema,
  membersSchema,
  ownersLeaderboardSchema,
  regionDetailSchema,
  regionListSchema,
  statsSchema,
  worldRefSchema,
  type ActivityEvent,
  type RegionDetail,
} from "./schemas";
import { z } from "zod";

/** Realty clamps oversized page sizes rather than rejecting them. */
export const MAX_PAGE_SIZE = 100;

export interface RegionKey {
  worldUuid: string;
  wgRegionId: string;
}

/**
 * Activity events carry no upstream id, so ingestion is made idempotent with a
 * content hash over the fields that identify an occurrence.
 */
export function activityDedupeHash(event: ActivityEvent): string {
  return createHash("sha1")
    .update(
      [
        event.eventTime,
        event.eventType,
        event.kind,
        event.world?.id ?? "",
        event.worldGuardRegionId ?? "",
        event.actor?.id ?? "",
        event.buyer?.id ?? "",
        event.tenant?.id ?? "",
        event.landlord?.id ?? "",
        event.agent?.id ?? "",
        event.authority?.id ?? "",
        event.price ?? "",
        event.durationSeconds ?? "",
      ].join("|"),
    )
    .digest("hex");
}

export function createRealtyClient(http: ApiClient) {
  return {
    async health() {
      return http.get("/health", {
        schema: z.looseObject({
          status: z.string(),
          module: z.string().nullish(),
        }),
        tolerate: [503],
      });
    },

    async worlds() {
      return (await http.get("/worlds", { schema: z.array(worldRefSchema) })) ?? [];
    },

    /** The cheap change probe that gates region re-indexing. */
    async stats() {
      return http.get("/stats", { schema: statsSchema });
    },

    /**
     * One page of the region index. Identity + state only — confirmed against
     * the live API, so full state still requires `regionDetail` per region.
     */
    async regionPage(page: number, pageSize = MAX_PAGE_SIZE) {
      return http.get("/regions", {
        query: { page, pageSize },
        schema: regionListSchema,
      });
    },

    /** Full state for one region. This is the per-region N+1. */
    async regionDetail(key: RegionKey): Promise<RegionDetail | null> {
      return http.get("/region", {
        query: { world: key.worldUuid, region: key.wgRegionId },
        schema: regionDetailSchema,
        // A region can vanish between indexing and detail fetch.
        tolerate: [404],
      });
    },

    /**
     * WorldGuard owners/members. Module-dependent: 502 means the query service
     * is down, which must not be mistaken for "this region has no members".
     */
    async regionMembers(key: RegionKey) {
      return http.get("/region/members", {
        query: { world: key.worldUuid, region: key.wgRegionId },
        schema: membersSchema,
        tolerate: [404, 502],
      });
    },

    /**
     * The server-wide delta feed, newest first. `since` must be RFC3339 with an
     * explicit offset; a bare local date-time is rejected outright.
     */
    async activity(options: {
      since?: Date;
      page?: number;
      pageSize?: number;
    }) {
      return http.get("/activity", {
        query: {
          since: options.since?.toISOString(),
          page: options.page ?? 1,
          pageSize: options.pageSize ?? MAX_PAGE_SIZE,
          type: [...ALL_ACTIVITY_TYPES],
        },
        schema: activitySchema,
      });
    },

    /**
     * Bulk source of title-holding players, ranked by plot count. Cheap way to
     * discover the property-owning subset of the roster without crawling every
     * region first (observed: 369 owners, i.e. ~4 pages).
     */
    async ownersLeaderboard(page: number, pageSize = MAX_PAGE_SIZE) {
      return http.get("/leaderboard/owners", {
        query: { page, pageSize },
        schema: ownersLeaderboardSchema,
      });
    },
  };
}

export type RealtyClient = ReturnType<typeof createRealtyClient>;
