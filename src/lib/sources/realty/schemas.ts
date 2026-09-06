import { z } from "zod";

/** Realty's live responses match docs/sources/realty.yaml exactly (verified by probe). */

export const worldRefSchema = z.looseObject({
  id: z.string(),
  name: z.string().nullish(),
});

export const playerRefSchema = z.looseObject({
  id: z.string(),
  /** Null when Realty's query-service module is down — a soft failure. */
  name: z.string().nullish(),
});

export const statsSchema = z.looseObject({
  regions: z.number(),
  activeOffers: z.number().nullish(),
  activeAuctions: z.number().nullish(),
});

const pageEnvelope = {
  page: z.number(),
  /** Read back rather than assumed: oversized pageSize is clamped, not rejected. */
  pageSize: z.number(),
  totalCount: z.number(),
  totalPages: z.number(),
};

export const regionListSchema = z.looseObject({
  ...pageEnvelope,
  regions: z.array(
    z.looseObject({
      worldGuardRegionId: z.string(),
      world: worldRefSchema,
      state: z.string().nullish(),
    }),
  ),
});

export const dimensionsSchema = z.looseObject({
  shape: z.string(),
  minY: z.number(),
  maxY: z.number(),
  points: z.array(z.looseObject({ x: z.number(), z: z.number() })),
});

export const regionDetailSchema = z.looseObject({
  worldGuardRegionId: z.string(),
  world: worldRefSchema,
  state: z.string().nullish(),
  freehold: z
    .looseObject({
      titleHolder: playerRefSchema.nullish(),
      authority: playerRefSchema.nullish(),
      price: z.number().nullish(),
      lastSoldPrice: z.number().nullish(),
      acceptingOffers: z.boolean().nullish(),
    })
    .nullish(),
  leasehold: z
    .looseObject({
      landlord: playerRefSchema.nullish(),
      tenant: playerRefSchema.nullish(),
      price: z.number().nullish(),
      durationSeconds: z.number().nullish(),
      startDate: z.string().nullish(),
      endDate: z.string().nullish(),
      extensionsUsed: z.number().nullish(),
      maxExtensions: z.number().nullish(),
      terminationEffectiveDate: z.string().nullish(),
      terminatedByRole: z.string().nullish(),
      acceptingTenants: z.boolean().nullish(),
    })
    .nullish(),
  auction: z
    .looseObject({
      auctioneer: playerRefSchema.nullish(),
      startDate: z.string().nullish(),
      endDate: z.string().nullish(),
      minBid: z.number().nullish(),
      minStep: z.number().nullish(),
      biddingDurationSeconds: z.number().nullish(),
      paymentDurationSeconds: z.number().nullish(),
      highestBid: z
        .looseObject({
          bidder: playerRefSchema.nullish(),
          amount: z.number().nullish(),
        })
        .nullish(),
    })
    .nullish(),
  dimensions: dimensionsSchema.nullish(),
  tags: z.array(z.string()).nullish(),
});

export const activitySchema = z.looseObject({
  ...pageEnvelope,
  events: z.array(
    z.looseObject({
      kind: z.string(),
      eventType: z.string(),
      eventTime: z.string(),
      worldGuardRegionId: z.string().nullish(),
      world: worldRefSchema.nullish(),
      actor: playerRefSchema.nullish(),
      buyer: playerRefSchema.nullish(),
      tenant: playerRefSchema.nullish(),
      landlord: playerRefSchema.nullish(),
      agent: playerRefSchema.nullish(),
      authority: playerRefSchema.nullish(),
      price: z.number().nullish(),
      durationSeconds: z.number().nullish(),
    }),
  ),
});

export const membersSchema = z.looseObject({
  owners: z.looseObject({
    players: z.array(playerRefSchema),
    playerNames: z.array(z.string()),
    groups: z.array(z.string()),
  }),
  members: z.looseObject({
    players: z.array(playerRefSchema),
    playerNames: z.array(z.string()),
    groups: z.array(z.string()),
  }),
});

export type RegionDetail = z.infer<typeof regionDetailSchema>;
export type ActivityEvent = z.infer<typeof activitySchema>["events"][number];
export type WorldRef = z.infer<typeof worldRefSchema>;

/**
 * The full event-type list. `/v1/activity` defaults to a four-event "ticker"
 * (BUY, AUCTION_BUY, OFFER_BUY, RENT), which silently omits ownership and price
 * changes — exactly the events that matter for keeping cached plots correct.
 * Every activity poll must pass these explicitly.
 */
export const ALL_ACTIVITY_TYPES = [
  "BUY",
  "AUCTION_BUY",
  "OFFER_BUY",
  "AGENT_ADD",
  "AGENT_REMOVE",
  "RENT",
  "UNRENT",
  "RENEW",
  "LEASEHOLD_EXPIRY",
  "SET_PRICE",
  "UNSET_PRICE",
  "SET_TITLEHOLDER",
  "UNSET_TITLEHOLDER",
  "SET_DURATION",
  "SET_LANDLORD",
  "SET_TENANT",
  "UNSET_TENANT",
  "SET_MAX_EXTENSIONS",
  "MODIFY_PROPOSE",
  "MODIFY_ACCEPT",
  "MODIFY_REJECT",
  "MODIFY_WITHDRAW",
  "MODIFY_APPLY",
  "TERMINATE",
  "TERMINATION_CANCEL",
] as const;

export const ownersLeaderboardSchema = z.looseObject({
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number(),
  totalPages: z.number(),
  owners: z.array(
    z.looseObject({
      rank: z.number().nullish(),
      player: playerRefSchema,
      plotCount: z.number().nullish(),
    }),
  ),
});
