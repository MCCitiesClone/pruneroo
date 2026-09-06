import { z } from "zod";

/**
 * Treasury REST API.
 *
 * Springdoc emitted every field as optional with no `required` arrays, so
 * everything here is nullish by default. Money is ALWAYS a decimal string
 * upstream — it is kept as a string through this layer and converted only at
 * the database boundary, where Postgres `numeric` holds it exactly.
 */

export const meSchema = z.looseObject({
  keyId: z.number().nullish(),
  ownerUuid: z.string().nullish(),
  keyType: z.string().nullish(), // PERSONAL | BUSINESS
  accountId: z.number().nullish(),
  firmId: z.number().nullish(),
});

export const accountByPlayerSchema = z.looseObject({
  accountId: z.number(),
  playerUuid: z.string().nullish(),
  playerName: z.string().nullish(),
});

export const accountBalanceSchema = z.looseObject({
  accountId: z.number().nullish(),
  balance: z.string().nullish(),
});

export const firmBalanceSchema = z.looseObject({
  firmId: z.number().nullish(),
  displayName: z.string().nullish(),
  totalBalance: z.string().nullish(),
});

export const publicFirmSchema = z.looseObject({
  firmId: z.number().nullish(),
  displayName: z.string().nullish(),
  discordUrl: z.string().nullish(),
  /** Looks like a WorldGuard region id, but carries no world — ambiguous join. */
  hqRegion: z.string().nullish(),
  defaultAccountId: z.number().nullish(),
  archived: z.boolean().nullish(),
  createdAt: z.string().nullish(),
});

