import { Suspense } from "react";
import Link from "next/link";

import {
  Badge,
  Duration,
  EmptyState,
  Money,
  PageHeader,
  RelativeTime,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { getEnv } from "@/lib/env";
import {
  countAtRiskProperties,
  findAtRiskProperties,
  listWorlds,
} from "@/lib/insights/at-risk";
import { parseAtRiskFilters } from "@/lib/insights/filters";
import {
  describeExempt,
  findLimitBreaches,
  getLimitsSummary,
} from "@/lib/insights/limits";
import {
  AREA_LABELS,
  categoryDefinition,
  limitApplies,
  type PlotArea,
} from "@/lib/plots/categories";

import { excludePlayerForm } from "../exclusions/actions";
import { Filters } from "./filters";

export const dynamic = "force-dynamic";

export default async function AtRiskPage(props: PageProps<"/at-risk">) {
  const env = getEnv();
  return (
    <>
      <PageHeader
        title="At-risk properties"
        description={
          <>
            Plots whose holder has gone inactive, been banned, been deported,
            or is over a plot limit. Inactivity means under the threshold of
            measured playtime in the trailing 30 days, read from the Analytics
            API&apos;s{" "}
            <code className="font-mono text-xs">active_playtime_30d</code>;
            over-limit means more plots of one zoning than Property Standards
            Act §17 allows, which files as a <strong>Plot Fairness</strong>{" "}
            report on a freehold, or <strong>Rental Limitations</strong> on a
            leasehold, rather than as an Inactivity one. A deportation only counts when it is
            indefinite or four months and up; a player serving a shorter one is
            coming back, so their plots are left alone — including the zero
            playtime the deportation itself causes. Defaults:{" "}
            {env.INACTIVITY_THRESHOLD_HOURS}h over 30 days.
          </>
        }
      />
      <Suspense fallback={<p className="text-sm text-muted">Loading filters…</p>}>
        <FilterBar searchParams={props.searchParams} />
      </Suspense>
      <Suspense fallback={null}>
        <LimitBreaches searchParams={props.searchParams} />
      </Suspense>
      <Suspense
        fallback={
          <p className="mt-6 text-sm text-muted">Querying properties…</p>
        }
      >
        <Results searchParams={props.searchParams} />
      </Suspense>
    </>
  );
}

async function FilterBar({
  searchParams,
}: Pick<PageProps<"/at-risk">, "searchParams">) {
  const [params, worlds] = await Promise.all([searchParams, listWorlds()]);
  const filters = parseAtRiskFilters(params);
  return <Filters worlds={worlds} current={filters} />;
}

async function Results({
  searchParams,
}: Pick<PageProps<"/at-risk">, "searchParams">) {
  const params = await searchParams;
  const filters = parseAtRiskFilters(params, { limit: 200 });

  const [rows, total] = await Promise.all([
    findAtRiskProperties(filters),
    countAtRiskProperties(filters),
  ]);

  if (rows.length === 0) {
    return (
      <div className="mt-6">
        <EmptyState>
          No properties match these filters. If the region backfill is still
          running, ownership data may not be loaded yet — check{" "}
          <Link href="/sync" className="text-accent underline">
            sync health
          </Link>
          .
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <p className="mb-3 text-sm text-muted">
        {total.toLocaleString()} matching {total === 1 ? "row" : "rows"}
        {rows.length < total ? ` — showing the first ${rows.length}` : ""}
      </p>
      <Table>
        <thead>
          <tr>
            <Th>Plot</Th>
            <Th>Zoning</Th>
            <Th>World</Th>
            <Th>Authority</Th>
            <Th>Role</Th>
            <Th>Flagged player</Th>
            <Th>Flags</Th>
            <Th align="right">30d playtime</Th>
            <Th>Last seen</Th>
            <Th align="right">Price</Th>
            <Th align="right">Balance</Th>
            <Th>Lease ends</Th>
            <Th align="right">Action</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.worldUuid}:${row.wgRegionId}:${row.role}:${row.playerUuid}`}
              className="hover:bg-surface-muted"
            >
              <Td mono>
                <Link
                  href={`/regions/${row.worldUuid}/${encodeURIComponent(row.wgRegionId)}`}
                  className="text-accent hover:underline"
                >
                  {row.wgRegionId}
                </Link>
                {row.state ? (
                  <div className="mt-0.5 text-[10px] text-muted">{row.state}</div>
                ) : null}
                {row.mergeMemberCount && row.mergeMemberCount > 1 ? (
                  <div className="mt-0.5">
                    <Badge
                      tone="neutral"
                      title={`Merged with ${row.mergeMemberCount - 1} other plot(s). PSA §18(2): a merged property is filed as a single eviction report.`}
                    >
                      merged ×{row.mergeMemberCount}
                    </Badge>
                  </div>
                ) : null}
              </Td>
              <Td>
                <Zoning category={row.category} area={row.area} />
              </Td>
              <Td>{row.worldName ?? "—"}</Td>
              <Td>
                {row.authorityUuid ? (
                  <Link
                    href={`/players/${row.authorityUuid}`}
                    className="text-accent hover:underline"
                  >
                    {row.authorityName ?? row.authorityUuid.slice(0, 8)}
                  </Link>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </Td>
              <Td>
                <span className="text-xs text-muted">{row.role}</span>
              </Td>
              <Td>
                <Link
                  href={`/players/${row.playerUuid}`}
                  className="text-accent hover:underline"
                >
                  {row.playerName ?? row.playerUuid.slice(0, 8)}
                </Link>
                {row.isExcluded ? (
                  <div className="mt-0.5">
                    <Badge
                      tone="neutral"
                      title={row.exclusionReason ?? "Excluded from review"}
                    >
                      excluded
                    </Badge>
                  </div>
                ) : null}
                {row.hasActiveReport && row.reportUrl ? (
                  <div className="mt-0.5">
                    <a
                      href={row.reportUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={row.reportTitle ?? "Open eviction report"}
                    >
                      <Badge tone="warn">eviction report</Badge>
                    </a>
                  </div>
                ) : null}
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {row.isBanned ? <Badge tone="danger">banned</Badge> : null}
                  {row.isDeported ? (
                    <Badge
                      tone={row.isLongDeported ? "danger" : "neutral"}
                      title={
                        row.isLongDeported
                          ? row.deportationKind === "indefinite"
                            ? "Deported indefinitely — no expiry, so the plot is not coming back into use."
                            : `Deported until ${row.deportationEndsAt?.toISOString().slice(0, 10)} — four months or more, which is grounds to evict.`
                          : `Deported until ${row.deportationEndsAt?.toISOString().slice(0, 10)}, under four months. Not grounds to evict; this row is here for another reason.`
                      }
                    >
                      deported
                      {row.isLongDeported
                        ? row.deportationKind === "indefinite"
                          ? ""
                          : " (long)"
                        : " (limited)"}
                    </Badge>
                  ) : null}
                  {row.flagReasons.includes("inactive") ? (
                    <Badge tone="warn">inactive</Badge>
                  ) : null}
                  {row.isOverLimit ? (
                    <Badge
                      tone={row.limitIsViolation ? "danger" : "warn"}
                      title={
                        row.limitNeedsRealtorCheck
                          ? `Holds ${row.limitCount} of ${row.limitValue} allowed. Within §17(9)'s realtor allowance — confirm with /about and mark them on their player page.`
                          : `Holds ${row.limitCount} of ${row.limitValue} allowed under PSA §17. ${
                              row.contractType === "leasehold"
                                ? "Leasehold, so it files as Rental Limitations — evicted on the date filed."
                                : "Plot Fairness report, 3-day resolve."
                            }`
                      }
                    >
                      over limit {row.limitCount}/{row.limitValue}
                    </Badge>
                  ) : null}
                  {row.isRealtor ? (
                    <Badge tone="ok" title="Realtor job confirmed; §17(9) adds 5 to most limits.">
                      realtor
                    </Badge>
                  ) : null}
                </div>
              </Td>
              <Td align="right">
                <Duration ms={row.playtime30dMs} />
                <PlaytimeSource source={row.playtime30dSource} />
              </Td>
              <Td>
                <RelativeTime value={row.lastSeenAt} />
              </Td>
              <Td align="right">
                <Money value={row.price} />
              </Td>
              <Td align="right">
                <Money value={row.balance} />
              </Td>
              <Td>
                <RelativeTime value={row.leaseEndAt} />
              </Td>
              <Td align="right">
                {row.isExcluded ? (
                  <span className="text-xs text-muted">hidden by default</span>
                ) : (
                  <form action={excludePlayerForm}>
                    <input
                      type="hidden"
                      name="playerUuid"
                      value={row.playerUuid}
                    />
                    <button
                      type="submit"
                      title={`Hide every property held by ${row.playerName ?? "this player"}`}
                      className="rounded border border-border-subtle px-2 py-1 text-xs whitespace-nowrap transition-colors hover:bg-surface-muted"
                    >
                      Exclude
                    </button>
                  </form>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

/**
 * Holder-level view of the §17 limits, folded into this page because a limit
 * breach is a reason a property is at risk — the rows it explains are in the
 * table below, flagged `over limit`.
 *
 * Collapsed by default: the property table is what an inspector acts on, and
 * this is the per-holder arithmetic behind the `over limit` rows.
 */
async function LimitBreaches({
  searchParams,
}: Pick<PageProps<"/at-risk">, "searchParams">) {
  const params = await searchParams;
  const filters = parseAtRiskFilters(params);

  const [summary, holders] = await Promise.all([
    getLimitsSummary(),
    findLimitBreaches({ includeExcluded: filters.includeExcluded }),
  ]);

  if (holders.length === 0) return null;

  return (
    <details className="mt-6 rounded-lg border border-border-subtle bg-surface p-4" open>
      <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted">
        Plot limits
        <span className="ml-2 normal-case">
          <span className={summary.holdersOverLimit > 0 ? "text-danger" : ""}>
            {summary.holdersOverLimit} over the limit
          </span>
          {" · "}
          <span className="text-warn">
            {summary.holdersNeedingRealtorCheck} to check
          </span>
          {summary.confirmedRealtors > 0
            ? ` · ${summary.confirmedRealtors} confirmed realtors`
            : ""}
        </span>
      </summary>

      <p className="mt-2 text-xs text-muted">
        Property Standards Act §17, counted across every world — the cap is on
        total holdings, so narrowing the scope above must not make a holder look
        compliant. Merged plots count as their individual sub-plots (§18(1)).
        Plots in Oakridge and Aventura are exempt entirely, and Willow
        commercial plots are exempt from the commercial limit; those are
        excluded from the counts and noted beside them. A holder within
        §17(9)&apos;s +{summary.realtorBonus} is shown as needing a realtor
        check — confirm with <code className="font-mono">/about</code> and mark
        them on their player page.
      </p>

      <div className="mt-3">
        <Table>
          <thead>
            <tr>
              <Th>Holder</Th>
              <Th align="right">Plots</Th>
              <Th>Over limit</Th>
              <Th>Full holdings</Th>
              <Th>Flags</Th>
            </tr>
          </thead>
          <tbody>
            {holders.map((holder) => (
              <tr key={holder.playerUuid} className="hover:bg-surface-muted">
                <Td>
                  <Link
                    href={`/players/${holder.playerUuid}`}
                    className="text-accent hover:underline"
                  >
                    {holder.playerName ?? holder.playerUuid.slice(0, 8)}
                  </Link>
                </Td>
                <Td align="right">{holder.totalPlots}</Td>
                <Td>
                  <div className="flex flex-col gap-1">
                    {holder.categories
                      .filter((c) => c.isViolation || c.needsRealtorCheck)
                      .map((c) => (
                        <span
                          key={c.category}
                          className="flex items-center gap-2"
                          title={c.note}
                        >
                          <Badge tone={c.isViolation ? "danger" : "warn"}>
                            {c.label} {c.count}/{c.limit}
                          </Badge>
                          {c.needsRealtorCheck ? (
                            <span className="text-[10px] text-muted">
                              allowed if realtor (≤{c.realtorLimit})
                            </span>
                          ) : null}
                        </span>
                      ))}
                  </div>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {holder.categories.map((c) => {
                      const exempt = describeExempt(c);
                      return (
                        <span
                          key={c.category}
                          title={exempt ? `${c.note} ${exempt}.` : c.note}
                          className="rounded bg-surface-muted px-1.5 py-0.5 text-[10px] text-muted"
                        >
                          {c.label} {c.count}
                          {c.limit !== null ? `/${c.limit}` : ""}
                          {exempt ? ` +${c.exemptCount} exempt` : ""}
                        </span>
                      );
                    })}
                  </div>
                </Td>
                <Td>
                  <div className="flex gap-1">
                    {holder.isRealtor ? <Badge tone="ok">realtor</Badge> : null}
                    {holder.isBanned ? <Badge tone="danger">banned</Badge> : null}
                    {holder.isDeported ? (
                      <Badge tone="danger">deported</Badge>
                    ) : null}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </details>
  );
}

/**
 * Zoning and area, which together decide whether a plot limit even applies.
 *
 * The two are separate axes: a plot tagged `oakridge` + `commercial` is
 * commercial zoning inside a town, and §17(10) exempts it. Willow is the
 * partial case — its commercial plots are exempt but its farmland is not — so
 * the exemption is shown per row rather than per area.
 */
function Zoning({ category, area }: { category: string | null; area: string | null }) {
  const definition = categoryDefinition(category ?? "other");
  const plotArea = (area as PlotArea) ?? null;
  const exempt = plotArea !== null && !limitApplies(plotArea, definition.category);

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs" title={definition.note}>
        {definition.label}
      </span>
      {plotArea ? (
        <span
          className="text-[10px] text-muted"
          title={
            exempt
              ? "Exempt from the standard ownership limit."
              : "Counts towards the standard ownership limit."
          }
        >
          {AREA_LABELS[plotArea]}
          {exempt ? " · exempt" : ""}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Provenance is shown on every row. A value deduced from `lastSeen` is exact
 * but was never measured directly, and an unmeasured player must never be
 * mistaken for one with zero playtime.
 */
function PlaytimeSource({
  source,
}: {
  source: "analytics_detail" | "inferred_zero" | "unknown";
}) {
  if (source === "analytics_detail") return null;
  if (source === "inferred_zero") {
    return (
      <div
        className="mt-0.5 text-[10px] text-muted"
        title="Last seen over 30 days ago, so the 30-day window necessarily contains no playtime. Exact, but deduced rather than measured."
      >
        inferred
      </div>
    );
  }
  return (
    <div
      className="mt-0.5 text-[10px] text-warn"
      title="Not yet fetched from the Analytics API. This row is flagged for another reason, not inactivity."
    >
      unmeasured
    </div>
  );
}
