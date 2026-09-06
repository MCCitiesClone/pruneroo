import type { ApiClient } from "@/lib/http/client";

import {
  accountBalanceSchema,
  accountByPlayerSchema,
  firmBalanceSchema,
  meSchema,
  publicFirmSchema,
} from "./schemas";

/**
 * Money is a decimal string upstream and must never round-trip through a JS
 * number — IEEE 754 silently corrupts large balances. This validates the string
 * and hands it on untouched; Postgres `numeric` does the arithmetic.
 */
export function parseMoney(value: string | null | undefined): {
  raw: string | null;
  numeric: string | null;
} {
  if (value === null || value === undefined) return { raw: null, numeric: null };
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { raw: value, numeric: null };
  }
  return { raw: value, numeric: trimmed };
}

export function createTreasuryClient(http: ApiClient) {
  return {
    /** Identifies the token's scope, which selects the rate-limit budget. */
    async me() {
      return http.get("/auth/me", { schema: meSchema, group: "auth" });
    },

    /**
     * The UUID -> accountId bridge. No batch form exists, so this is one call
     * per player at 60/min (PERSONAL) or 300/min (BUSINESS). Results are cached
     * permanently because accountId never changes.
     */
    async accountByPlayer(playerUuid: string) {
      return http.get("/accounts/by-player", {
        query: { uuid: playerUuid },
        schema: accountByPlayerSchema,
        group: "byPlayer",
        tolerate: [404],
      });
    },

    async balance(accountId: number) {
      return http.get(`/accounts/${accountId}/balance`, {
        schema: accountBalanceSchema,
        group: "balance",
        tolerate: [404],
      });
    },

    /** Firms are only addressable by name — there is no list-all-firms endpoint. */
    async firmByName(firmName: string) {
      return http.get(`/firms/${encodeURIComponent(firmName)}`, {
        schema: publicFirmSchema,
        group: "firms",
        tolerate: [404],
      });
    },

    async firmBalance(firmName: string) {
      return http.get(`/firms/${encodeURIComponent(firmName)}/balance`, {
        schema: firmBalanceSchema,
        group: "firms",
        tolerate: [404],
      });
    },

  };
}

export type TreasuryClient = ReturnType<typeof createTreasuryClient>;
