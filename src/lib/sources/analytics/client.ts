import type { ApiClient } from "@/lib/http/client";
import { normalizeName, normalizeUuid } from "@/lib/identity";

import { parseDurationMs } from "./duration";
import {
  playerDetailSchema,
  playersTableSchema,
  whoamiSchema,
  type TablePlayer,
} from "./schemas";

export interface RosterEntry {
  playerUuid: string;
  playerName: string | null;
  playtimeActiveMs: number | null;
  sessionCount: number | null;
  lastSeenAt: Date | null;
  registeredAt: Date | null;
  activityIndex: number | null;
  country: string | null;
}

/** Plan timestamps are epoch milliseconds; 0 means "never". */
function msToDate(value: number | null | undefined): Date | null {
  if (value === null || value === undefined || value <= 0) return null;
  return new Date(value);
}

function normalizeRosterEntry(row: TablePlayer): RosterEntry | null {
  const playerUuid = normalizeUuid(row.playerUUID);
  if (!playerUuid) return null;
  return {
    playerUuid,
    playerName: normalizeName(row.playerName),
    playtimeActiveMs: row.playtimeActive ?? null,
    sessionCount: row.sessionCount ?? null,
    lastSeenAt: msToDate(row.lastSeen),
    registeredAt: msToDate(row.registered),
    activityIndex: row.activityIndex ?? null,
    country: normalizeName(row.country),
  };
}

/**
 * The 30-day figure this whole application hinges on. Plan nests it under
 * `online_activity`, but the key has been observed under a couple of spellings
 * across Plan versions, so a small set of aliases is accepted before giving up.
 */
const PLAYTIME_30D_KEYS = [
  "active_playtime_30d",
  "playtime_30d",
  "active_playtime_month",
];

export function extractPlaytime30dMs(detail: unknown): {
  ms: number | null;
  key: string | null;
  raw: unknown;
} {
  if (!detail || typeof detail !== "object") {
    return { ms: null, key: null, raw: null };
  }
  const activity = (detail as Record<string, unknown>).online_activity;
  if (!activity || typeof activity !== "object") {
    return { ms: null, key: null, raw: null };
  }
  const record = activity as Record<string, unknown>;
  for (const key of PLAYTIME_30D_KEYS) {
    if (key in record) {
      return { ms: parseDurationMs(record[key]), key, raw: record[key] };
    }
  }
  return { ms: null, key: null, raw: null };
}

export function createAnalyticsClient(http: ApiClient) {
  return {
    async whoami() {
      return http.get("/whoami", { schema: whoamiSchema });
    },

    /**
     * The bulk roster: every player's lifetime playtime, last seen and join
     * date in a single request. No pagination exists, so this is one large
     * payload — hence the source's concurrency limit of 1.
     */
    async roster(): Promise<RosterEntry[]> {
      const result = await http.get("/playersTable", {
        schema: playersTableSchema,
      });
      if (!result) return [];
      return result.players
        .map(normalizeRosterEntry)
        .filter((entry): entry is RosterEntry => entry !== null);
    },

    /**
     * Per-player detail — the source of 30-day playtime, and the N+1 that the
     * sync layer works hard to avoid making unnecessarily.
     */
    async playerDetail(playerUuid: string) {
      const detail = await http.get(`/player`, {
        query: { player: playerUuid },
        schema: playerDetailSchema,
        raw: true,
        tolerate: [400, 404],
      });
      if (!detail) return null;
      const extracted = extractPlaytime30dMs(detail);
      return { detail, ...extracted };
    },
  };
}

export type AnalyticsClient = ReturnType<typeof createAnalyticsClient>;
