import { getEnv } from "@/lib/env";

import { type AtRiskFilters, type StakeholderRole } from "./at-risk";
import { type PruneFilters, type PruneSort } from "./prune";
import { ALL_REASONS, type FlagReason } from "./reasons";

/**
 * One parser for the at-risk query string, shared by the page and the CSV
 * export.
 *
 * These were parsed separately at first and silently diverged: the export read
 * the threshold with `Number(params.get("hours"))`, and `Number(null)` is `0`,
 * not `NaN`. `Number.isFinite(0)` is true, so a missing parameter became a
 * 0-hour threshold instead of the configured default — no row can have less
 * than zero playtime, so every inactive property vanished from the CSV while
 * the page still showed them. A download that quietly disagrees with the screen
 * is worse than one that fails.
 */

/** Sentinel meaning "no filter" for parameters that otherwise have a default. */
export const ALL = "all";

const VALID_REASONS: FlagReason[] = ALL_REASONS;
const VALID_ROLES: StakeholderRole[] = [
  "titleholder",
  "landlord",
  "tenant",
  "authority",
  "wg_owner",
  "wg_member",
];
const VALID_SORTS: NonNullable<AtRiskFilters["sort"]>[] = [
  "player",
  "authority",
  "world",
  "price",
  "playtime",
  "lease_end",
];

/** Accepts Next's `searchParams` object or a `URLSearchParams`. */
export type QueryInput =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

function readOne(input: QueryInput, key: string): string | undefined {
  if (input instanceof URLSearchParams) return input.get(key) ?? undefined;
  const value = input[key];
  return Array.isArray(value) ? value[0] : value;
}

function readMany(input: QueryInput, key: string): string[] {
  const raw =
    input instanceof URLSearchParams
      ? input.getAll(key)
      : ((): string[] => {
          const value = input[key];
          if (value === undefined) return [];
          return Array.isArray(value) ? value : [value];
        })();
  // Tolerate both repeated params and comma-joined values.
  return raw.flatMap((v) => v.split(",")).filter(Boolean);
}

export function parseAtRiskFilters(
  input: QueryInput,
  overrides: Partial<AtRiskFilters> = {},
): AtRiskFilters {
  const env = getEnv();

  const reasons = readMany(input, "reason").filter((r): r is FlagReason =>
    VALID_REASONS.includes(r as FlagReason),
  );
  const roles = readMany(input, "role").filter((r): r is StakeholderRole =>
    VALID_ROLES.includes(r as StakeholderRole),
  );

  // Only parse a threshold when one was actually supplied — see the note above.
  const rawHours = readOne(input, "hours");
  const parsedHours = rawHours === undefined ? NaN : Number(rawHours);
  const thresholdHours =
    Number.isFinite(parsedHours) && parsedHours >= 0
      ? parsedHours
      : env.INACTIVITY_THRESHOLD_HOURS;

  const contract = readOne(input, "contract");
  const sort = readOne(input, "sort") as AtRiskFilters["sort"];

  // World and authority default to the actionable slice rather than to "no
  // filter". `all` is the explicit opt-out, so an absent parameter means "use
  // the default" and an empty one is not mistaken for "show everything".
  const rawWorld = readOne(input, "world");
  const worldUuid =
    rawWorld === ALL ? undefined : rawWorld || env.DEFAULT_WORLD_UUID;

  const rawAuthority = readOne(input, "authority");
  const authority =
    rawAuthority === ALL
      ? undefined
      : rawAuthority?.trim() || env.DEFAULT_AUTHORITY;

  return {
    thresholdHours,
    reasons: reasons.length > 0 ? reasons : undefined,
    roles: roles.length > 0 ? roles : undefined,
    worldUuid,
    contractType:
      contract === "freehold" || contract === "leasehold" ? contract : undefined,
    includeUnknownPlaytime: readOne(input, "unknown") === "1",
    includeExcluded: readOne(input, "excluded") === "1",
    includeReported: readOne(input, "reported") === "1",
    authority,
    sort: sort && VALID_SORTS.includes(sort) ? sort : "player",
    direction: readOne(input, "dir") === "desc" ? "desc" : "asc",
    ...overrides,
  };
}

/** Offered page sizes. Anything else falls back to the configured default. */
export const PAGE_SIZES = [25, 50];

const VALID_PRUNE_SORTS: PruneSort[] = [
  "balance",
  "player",
  "last_seen",
  "registered",
];

/**
 * Parser for the prune query string.
 *
 * Thresholds are read with the same "only parse what was actually supplied"
 * discipline as `parseAtRiskFilters` above, and for the same reason:
 * `Number(null)` is `0`, and a silently-zeroed `days` would turn "dormant for
 * 90 days" into "dormant for 0 days" — every player on the server, presented
 * as prunable.
 */
export function parsePruneFilters(
  input: QueryInput,
  overrides: Partial<PruneFilters> = {},
): PruneFilters {
  const env = getEnv();

  const rawDays = readOne(input, "days");
  const parsedDays = rawDays === undefined ? NaN : Number(rawDays);
  const inactivityDays =
    Number.isFinite(parsedDays) && parsedDays > 0
      ? parsedDays
      : env.PRUNE_INACTIVITY_DAYS;

  const rawMin = readOne(input, "min");
  const parsedMin = rawMin === undefined ? NaN : Number(rawMin);
  const minBalance =
    Number.isFinite(parsedMin) && parsedMin >= 0
      ? parsedMin
      : env.PRUNE_MIN_BALANCE;

  const sort = readOne(input, "sort") as PruneSort | undefined;

  // Page size is capped: it is also the number of upstream balance reads a
  // single page load will issue, so an arbitrary ?size= must not turn one
  // request for a page into thousands.
  const rawSize = readOne(input, "size");
  const parsedSize = rawSize === undefined ? NaN : Number(rawSize);
  const size = PAGE_SIZES.includes(parsedSize) ? parsedSize : env.PRUNE_PAGE_SIZE;

  const rawPage = readOne(input, "page");
  const parsedPage = rawPage === undefined ? NaN : Number(rawPage);
  const page =
    Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.floor(parsedPage) : 1;

  return {
    inactivityDays,
    minBalance,
    limit: size,
    offset: (page - 1) * size,
    includeExcluded: readOne(input, "excluded") === "1",
    search: readOne(input, "q")?.trim() || undefined,
    sort: sort && VALID_PRUNE_SORTS.includes(sort) ? sort : "balance",
    // Biggest balances first: the order an operator actually works in.
    direction: readOne(input, "dir") === "asc" ? "asc" : "desc",
    ...overrides,
  };
}
