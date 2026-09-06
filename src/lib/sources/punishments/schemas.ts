import { z } from "zod";

/**
 * Schemas for the LibertyBans punishments service, written against live
 * responses captured in docs/probes/ — NOT against docs/sources/punishment.yaml,
 * which describes a materially different API (see the notes on the
 * `punishments` table in src/lib/db/schema.ts).
 *
 * Objects are loose so an upstream addition never breaks ingestion.
 */

export const punishmentRecordSchema = z.looseObject({
  victimUuid: z.string(),
  victimUsername: z.string().nullish(),
  operatorUuid: z.string().nullish(),
  operatorUsername: z.string().nullish(),
  /**
   * Optional: KICK records omit `reason` entirely (e.g. /punishments/kick/17).
   * Defaulted rather than nullable so downstream string handling stays simple.
   */
  reason: z.string().nullish().transform((v) => v ?? ""),
  /** Observed always false upstream — recorded, never trusted. */
  active: z.boolean().nullish(),
  /** Epoch SECONDS. */
  start: z.number(),
  /** Epoch SECONDS, or 0 meaning permanent. */
  end: z.number(),
  /** "Permanent" | "Active" | "Expired" — the real status. */
  label: z.string().nullish(),
});

export type PunishmentRecord = z.infer<typeof punishmentRecordSchema>;

/**
 * Overrunning the last page returns 200 with `{"morePages": false}` and no
 * `punishments` key at all, so the array is optional.
 */
export const punishmentPageSchema = z.looseObject({
  morePages: z.boolean().nullish(),
  punishments: z.array(punishmentRecordSchema).nullish(),
});

export type PunishmentPage = z.infer<typeof punishmentPageSchema>;

/** `/stats/ban` and `/stats/mute` both return `{ "stats": <count> }`. */
export const punishmentStatsSchema = z.looseObject({
  stats: z.number(),
});

/**
 * BAN and MUTE are the documented endpoints. WARN and KICK are undocumented but
 * live (`/stats/warn` = 4724, `/stats/kick` = 521), and deportations are issued
 * as WARNs as often as MUTEs — omitting them made the deportation flag
 * incomplete.
 *
 * Careful: any *unrecognised* type string silently returns the BAN list rather
 * than 404, so only these four values may ever be sent.
 */
export const PUNISHMENT_TYPES = ["BAN", "MUTE", "WARN", "KICK"] as const;
export type PunishmentType = (typeof PUNISHMENT_TYPES)[number];
