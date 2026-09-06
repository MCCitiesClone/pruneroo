import type { NextRequest } from "next/server";

import { findAtRiskProperties } from "@/lib/insights/at-risk";
import { parseAtRiskFilters } from "@/lib/insights/filters";
import { HOUR_MS } from "@/lib/sources/analytics/duration";

/** CSV export of the at-risk table, honouring the same filters as the page. */

const COLUMNS = [
  "world",
  "plot",
  "state",
  "contract_type",
  "zoning",
  "area",
  "merged_with",
  "authority",
  "role",
  "flagged_player",
  "player_uuid",
  "flags",
  "over_limit",
  "limit_allowed",
  "realtor",
  "playtime_30d_hours",
  "playtime_30d_source",
  "last_seen",
  "price",
  "balance",
  "lease_ends",
  "excluded",
  "eviction_report",
] as const;

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // Guard against spreadsheet formula injection in exported data.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function GET(request: NextRequest) {
  const filters = parseAtRiskFilters(request.nextUrl.searchParams, {
    limit: 1000,
  });
  const rows = await findAtRiskProperties(filters);

  const lines = [
    COLUMNS.join(","),
    ...rows.map((row) =>
      [
        row.worldName ?? row.worldUuid,
        row.wgRegionId,
        row.state,
        row.contractType,
        row.category,
        row.area,
        // Merged plots are filed as one report, so the export says how many
        // plots travel with this row rather than implying it stands alone.
        row.mergeMemberCount ? row.mergeMemberCount - 1 : "",
        row.authorityName,
        row.role,
        row.playerName,
        row.playerUuid,
        row.flagReasons.join(" "),
        row.isOverLimit ? row.limitCount : "",
        row.isOverLimit ? row.limitValue : "",
        row.isRealtor ? "confirmed" : row.limitNeedsRealtorCheck ? "check" : "",
        row.playtime30dMs === null
          ? ""
          : (row.playtime30dMs / HOUR_MS).toFixed(2),
        row.playtime30dSource,
        row.lastSeenAt?.toISOString() ?? "",
        row.price,
        row.balance,
        row.leaseEndAt?.toISOString() ?? "",
        row.isExcluded ? "yes" : "",
        row.hasActiveReport ? (row.reportUrl ?? "yes") : "",
      ]
        .map(escapeCsv)
        .join(","),
    ),
  ];

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="at-risk-properties-${stamp}.csv"`,
    },
  });
}
