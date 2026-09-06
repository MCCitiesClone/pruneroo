import { createHash } from "node:crypto";

import type { ApiClient } from "@/lib/http/client";
import { classifyVictim, normalizeName, normalizeUuid } from "@/lib/identity";

import { parseDeportation } from "./deportation";
import {
  punishmentPageSchema,
  punishmentStatsSchema,
  type PunishmentRecord,
  type PunishmentType,
} from "./schemas";

/** A punishment normalised for storage. */
export interface NormalizedPunishment {
  id: string;
  type: PunishmentType;
  victimRaw: string;
  victimKind: "uuid" | "ip";
  victimUuid: string | null;
  victimName: string | null;
  operatorUuid: string | null;
  operatorName: string | null;
  reason: string;
  label: string | null;
  reportedActive: boolean | null;
  startAt: Date | null;
  endAt: Date | null;
  isPermanent: boolean;
  deportationCompletedAt: Date | null;
  deportationExpiresAt: Date | null;
}

/**
 * Upstream records carry no id, so identity is a content hash. Fields chosen
 * are the ones that cannot change for a given punishment: who, when it started,
 * why, and which list it came from.
 */
function synthesizeId(
  type: PunishmentType,
  record: PunishmentRecord,
): string {
  return createHash("sha1")
    .update(`${type}|${record.victimUuid}|${record.start}|${record.reason}`)
    .digest("hex");
}

/** ECMAScript caps Date at ±8.64e15 ms; anything beyond is not representable. */
const MAX_DATE_MS = 8.64e15;

/**
 * Upstream timestamps are epoch seconds, but "permanent" is encoded two
 * different ways in live data:
 *
 *   end = 0                  the documented sentinel
 *   end = 9223372036854775   Java's Long.MAX_VALUE in millis, re-expressed as
 *                            seconds — observed on real ban records
 *
 * Both must map to null, and the overflow guard also stops any other
 * out-of-range value from throwing `RangeError: Invalid time value` deep inside
 * the database driver.
 */
function secondsToDate(value: number | null | undefined): Date | null {
  if (value === null || value === undefined || value <= 0) return null;
  const ms = value * 1000;
  if (!Number.isFinite(ms) || ms > MAX_DATE_MS) return null;
  return new Date(ms);
}

/** True when a punishment never expires, under either sentinel encoding. */
export function isPermanentEnd(end: number): boolean {
  return secondsToDate(end) === null;
}

export function normalizePunishment(
  type: PunishmentType,
  record: PunishmentRecord,
): NormalizedPunishment {
  const victim = classifyVictim(record.victimUuid);
  const deportation = parseDeportation(record.reason);
  return {
    id: synthesizeId(type, record),
    type,
    victimRaw: record.victimUuid,
    victimKind: victim.kind,
    victimUuid: victim.uuid,
    victimName: normalizeName(record.victimUsername),
    operatorUuid: normalizeUuid(record.operatorUuid),
    operatorName: normalizeName(record.operatorUsername),
    reason: record.reason,
    label: normalizeName(record.label),
    reportedActive: record.active ?? null,
    startAt: secondsToDate(record.start),
    endAt: secondsToDate(record.end),
    isPermanent: isPermanentEnd(record.end),
    deportationCompletedAt: deportation.completedAt,
    deportationExpiresAt: deportation.expiresAt,
  };
}

export function createPunishmentsClient(http: ApiClient) {
  return {
    /** O(1) change probe. Returns the total count of that punishment type. */
    async count(type: PunishmentType): Promise<number> {
      const result = await http.get(`/stats/${type.toLowerCase()}`, {
        schema: punishmentStatsSchema,
      });
      return result?.stats ?? 0;
    },

    /**
     * One page (observed page size: 6). Returns null once the pages run out —
     * upstream signals that with 200 + `{"morePages": false}` and no array,
     * not the 404 its spec advertises.
     */
    async page(
      type: PunishmentType,
      page: number,
    ): Promise<{ items: NormalizedPunishment[]; morePages: boolean } | null> {
      const result = await http.get(`/punishments/${type.toLowerCase()}/${page}`, {
        schema: punishmentPageSchema,
        // Tolerate 404 anyway — the spec claims it, even if live behaviour differs.
        tolerate: [404],
      });
      if (!result) return null;
      const records = result.punishments ?? [];
      if (records.length === 0) return null;
      return {
        items: records.map((record) => normalizePunishment(type, record)),
        morePages: result.morePages ?? false,
      };
    },
  };
}

export type PunishmentsClient = ReturnType<typeof createPunishmentsClient>;
