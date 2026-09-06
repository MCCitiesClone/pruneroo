import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { playerActivityWindow, playerAnalytics } from "@/lib/db/schema";
import { getSources } from "@/lib/sources";
import { analyticsCredentialsConfigured } from "@/lib/sources/analytics/session";

import { enqueueMany, startRun } from "../queue";
import { upsertPlayers } from "../players";

const SOURCE = "analytics";

/**
 * Cap how many per-player fetches one roster pass may queue. At 30 req/min a
 * larger burst would monopolise the analytics budget for hours; the remainder
 * is simply picked up on the next pass.
 */
const MAX_DETAIL_JOBS_PER_PASS = 400;

/**
 * Bulk roster: one request returns every player's lifetime playtime, last seen
 * and join date. This is also where the per-player refresh set is computed.
 */
export async function handleAnalyticsPlayersTable(): Promise<void> {
  const run = await startRun(SOURCE, "analytics.playersTable");

  if (!analyticsCredentialsConfigured()) {
    await run.finish({
      status: "skipped",
      note:
        "ANALYTICS_USERNAME / ANALYTICS_PASSWORD not set. The Plan webserver " +
        "reports authRequired=true, and serves an HTML login page instead of " +
        "JSON when unauthenticated.",
    });
    return;
  }

  const { analytics } = getSources();
  let upserted = 0;

  try {
    const roster = await analytics.roster();

    await upsertPlayers(
      roster.map((entry) => ({ id: entry.playerUuid, name: entry.playerName })),
    );

    const CHUNK = 1000;
    for (let i = 0; i < roster.length; i += CHUNK) {
      const rows = roster.slice(i, i + CHUNK).map((entry) => ({
        playerUuid: entry.playerUuid,
        playtimeActiveMs: entry.playtimeActiveMs,
        sessionCount: entry.sessionCount,
        lastSeenAt: entry.lastSeenAt,
        registeredAt: entry.registeredAt,
        activityIndex: entry.activityIndex,
        country: entry.country,
        syncedAt: new Date(),
      }));
      await db
        .insert(playerAnalytics)
        .values(rows)
        .onConflictDoUpdate({
          target: playerAnalytics.playerUuid,
          set: {
            playtimeActiveMs: sql`EXCLUDED.playtime_active_ms`,
            sessionCount: sql`EXCLUDED.session_count`,
            lastSeenAt: sql`EXCLUDED.last_seen_at`,
            registeredAt: sql`EXCLUDED.registered_at`,
            activityIndex: sql`EXCLUDED.activity_index`,
            country: sql`EXCLUDED.country`,
            syncedAt: new Date(),
          },
        });
      upserted += rows.length;
    }

    const queued = await enqueueStaleDetailJobs();

    await run.finish({
      status: "ok",
      requestsMade: 1,
      itemsUpserted: upserted,
      note: `Roster of ${upserted}; queued ${queued} per-player 30-day fetches`,
    });
  } catch (error) {
    await run.finish({
      status: "error",
      requestsMade: 1,
      itemsUpserted: upserted,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Decide who actually needs a `/v1/player` call.
 *
 * Fetching 30-day playtime for the whole roster would take hours at 30 req/min.
 * Two exact deductions shrink the set — neither is an approximation:
 *
 *   1. Last seen more than 30 days ago  =>  30-day playtime is necessarily 0.
 *      The bulk roster already told us `lastSeen`, so these players never need
 *      a call; `v_player_flags` reports them as `inferred_zero`.
 *
 *   2. Lifetime playtime unchanged since the last detail fetch  =>  no new play
 *      has happened, so the 30-day figure can only have decreased as the window
 *      slid. A player already under the threshold stays under it.
 *
 * On top of that, only players with a stake in a property are queried at all —
 * they are the only ones the insight is about, and there are far fewer of them
 * (observed: 369 titleholders against a much larger roster).
 */
async function enqueueStaleDetailJobs(): Promise<number> {
  const result = await db.execute<{ uuid: string; priority: number }>(sql`
    SELECT p.uuid,
           CASE WHEN s.player_uuid IS NOT NULL THEN 50 ELSE 200 END AS priority
      FROM players p
      JOIN player_analytics a ON a.player_uuid = p.uuid
      LEFT JOIN player_activity_window w ON w.player_uuid = p.uuid
      LEFT JOIN LATERAL (
        SELECT 1 AS player_uuid
          FROM v_region_stakeholders vs
         WHERE vs.player_uuid = p.uuid
         LIMIT 1
      ) s ON true
     WHERE s.player_uuid IS NOT NULL
       -- Deduction 1: absent for the whole window, so the answer is 0.
       AND a.last_seen_at IS NOT NULL
       AND a.last_seen_at >= now() - interval '30 days'
       -- Deduction 2: no new play since we last asked.
       AND (
         w.player_uuid IS NULL
         OR w.lifetime_playtime_at_fetch_ms IS DISTINCT FROM a.playtime_active_ms
       )
     ORDER BY priority ASC, a.last_seen_at DESC
     LIMIT ${MAX_DETAIL_JOBS_PER_PASS}
  `);

  const jobs = result.rows.map((row) => ({
    source: SOURCE,
    kind: "analytics.player.detail",
    dedupeKey: row.uuid,
    payload: { playerUuid: row.uuid },
    priority: row.priority,
  }));

  await enqueueMany(jobs);
  return jobs.length;
}

/**
 * Fetch one player's 30-day playtime.
 *
 * `lifetimePlaytimeAtFetchMs` is captured alongside so the next roster pass can
 * tell whether this value is still current without asking again.
 */
export async function handleAnalyticsPlayerDetail(payload: {
  playerUuid: string;
}): Promise<void> {
  const { analytics } = getSources();
  const result = await analytics.playerDetail(payload.playerUuid);
  if (!result) return;

  const [current] = await db
    .select({ lifetime: playerAnalytics.playtimeActiveMs })
    .from(playerAnalytics)
    .where(sql`${playerAnalytics.playerUuid} = ${payload.playerUuid}`)
    .limit(1);

  await db
    .insert(playerActivityWindow)
    .values({
      playerUuid: payload.playerUuid,
      activePlaytime30dMs: result.ms,
      lifetimePlaytimeAtFetchMs: current?.lifetime ?? null,
      fetchedAt: new Date(),
      // The endpoint is untyped upstream; keeping the payload means a parsing
      // mistake can be corrected later without re-fetching every player.
      raw: { online_activity: (result.detail as Record<string, unknown>)?.online_activity ?? null, matchedKey: result.key, rawValue: result.raw },
    })
    .onConflictDoUpdate({
      target: playerActivityWindow.playerUuid,
      set: {
        activePlaytime30dMs: sql`EXCLUDED.active_playtime_30d_ms`,
        lifetimePlaytimeAtFetchMs: sql`EXCLUDED.lifetime_playtime_at_fetch_ms`,
        fetchedAt: new Date(),
        raw: sql`EXCLUDED.raw`,
      },
    });
}
