import { z } from "zod";

/**
 * Plan Player Analytics.
 *
 * The OpenAPI dump declares `/v1/player` as `"application/json": {}` — entirely
 * untyped — so these schemas are deliberately permissive: only the handful of
 * fields actually consumed are required, and everything else passes through.
 */

export const whoamiSchema = z.looseObject({
  authRequired: z.boolean().nullish(),
  loggedIn: z.boolean().nullish(),
});

/** One row of `GET /v1/playersTable` — the bulk roster call. */
export const tablePlayerSchema = z.looseObject({
  playerUUID: z.string(),
  playerName: z.string().nullish(),
  activityIndex: z.number().nullish(),
  /** Lifetime active playtime. Unit is undeclared upstream; ms in practice. */
  playtimeActive: z.number().nullish(),
  sessionCount: z.number().nullish(),
  /** Epoch milliseconds. */
  lastSeen: z.number().nullish(),
  /** Epoch milliseconds. */
  registered: z.number().nullish(),
  country: z.string().nullish(),
});

export const playersTableSchema = z.looseObject({
  players: z.array(tablePlayerSchema),
});

export type TablePlayer = z.infer<typeof tablePlayerSchema>;

/**
 * `GET /v1/player?player=<uuid>`.
 *
 * The only field this app needs is `online_activity.active_playtime_30d`, which
 * is why the rest of the (large, undocumented) payload is left unvalidated.
 * The value's runtime type is confirmed by scripts/probe.ts before being
 * trusted — Plan sometimes emits pre-formatted strings alongside raw numbers.
 */
export const playerDetailSchema = z.looseObject({
  online_activity: z.looseObject({}).nullish(),
});

export type PlayerDetail = z.infer<typeof playerDetailSchema>;
