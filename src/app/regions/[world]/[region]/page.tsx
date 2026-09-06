import Link from "next/link";
import { notFound } from "next/navigation";

import {
  Badge,
  Card,
  Duration,
  Money,
  PageHeader,
  RelativeTime,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { getEnv } from "@/lib/env";
import { getRegion } from "@/lib/insights/player";
import {
  buildReportKits,
  describeResolveTime,
  detectReportReason,
} from "@/lib/insights/report-kit";
import { categoryDefinition } from "@/lib/plots/categories";
import { HOUR_MS } from "@/lib/sources/analytics/duration";
import { ReportKitPanel } from "@/components/report-kit";
import { LinkReport } from "@/app/regions/link-report";

export const dynamic = "force-dynamic";

export default async function RegionPage(
  props: PageProps<"/regions/[world]/[region]">,
) {
  const { world, region: regionId } = await props.params;
  const region = await getRegion(world, decodeURIComponent(regionId));
  if (!region) notFound();

  const definition = categoryDefinition(region.category ?? "other");

  // A merged plot is filed as one report (PSA §18(2)), so the kit covers every
  // sub-plot. The clock is read once here rather than inside a component.
  const plotIds = [
    region.wgRegionId,
    ...region.mergedWith.map((m) => m.wgRegionId),
  ];
  // The open report on this plot, if one has been filed. Its URL is the last
  // argument `/dct-eviction-notice add` needs, so linking a report completes
  // the kit rather than merely annotating it.
  const openReport = region.reports.find((r) => r.isActive) ?? null;
  const kits = buildReportKits({
    plotIds,
    ownerName: region.ownerName,
    now: new Date(),
    reportUrl: openReport?.url ?? null,
  });

  // Only inactivity and a plot-limit breach are decidable from cached data; the
  // other three reasons are judgements about the build, so they are offered,
  // never guessed. A limit breach in a category this plot is exempt from is not
  // a reason to file against *this* plot, and the plot's tenure decides whether
  // the breach files as Plot Fairness or Rental Limitations.
  const detection = detectReportReason({
    isBanned: region.owner?.isBanned ?? false,
    isDeported: region.owner?.isLongDeported ?? false,
    // A limited deportation zeroes playtime by definition, so it is not
    // evidence of inactivity until the deportation lapses.
    playtime30dMs:
      region.owner?.isDeported && !region.owner.isLongDeported
        ? null
        : (region.owner?.playtime30dMs ?? null),
    thresholdMs: getEnv().INACTIVITY_THRESHOLD_HOURS * HOUR_MS,
    overLimit: Boolean(region.limit?.overLimit && region.limit.countsTowardLimit),
    limitLabel: definition.label.toLowerCase(),
    limitCount: region.limit?.count,
    limitValue: region.limit?.limitValue,
    needsRealtorCheck: region.limit?.needsRealtorCheck,
    contractType: region.contractType,
  });
  const detected = detection.reason ? kits[detection.reason] : null;

  return (
    <>
      <PageHeader
        title={region.wgRegionId}
        description={
          <>
            {region.worldName ?? region.worldUuid} ·{" "}
            {region.contractType ?? "no contract"}
            {region.state ? ` · ${region.state}` : ""} · {definition.label}
            {region.area ? ` (${region.area})` : ""}
          </>
        }
        actions={
          region.detailFetchedAt === null ? (
            <Badge tone="warn">detail not yet fetched</Badge>
          ) : null
        }
      />

      {region.reports.length > 0 ? (
        <Card
          className={
            region.reports.some((r) => r.isActive)
              ? "mb-4 border-warn/50"
              : "mb-4"
          }
        >
          <h2 className="text-sm font-semibold">
            Eviction {region.reports.length === 1 ? "report" : "reports"}
          </h2>
          <ul className="mt-2 space-y-2">
            {region.reports.map((report) => (
              <li key={report.threadId} className="flex flex-wrap items-baseline gap-2">
                <Badge
                  tone={report.isActive ? "warn" : "neutral"}
                  title={
                    report.feed === "archive"
                      ? "Archived on the forum — kept as history, does not suppress this plot from review"
                      : "Open report — this plot is hidden from the at-risk list"
                  }
                >
                  {report.prefix ??
                    (report.isActive ? "open" : "previous report")}
                </Badge>
                <a
                  href={report.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  {report.title}
                </a>
                <span className="text-xs text-muted">
                  {report.author ? `by ${report.author} · ` : ""}
                  filed <RelativeTime value={report.postedAt} />
                  {report.evictionDate ? (
                    <>
                      {" · eviction "}
                      <RelativeTime value={report.evictionDate} />
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            {region.reports.some((r) => r.isActive)
              ? "An open report means this plot is already being handled, so it is hidden from the at-risk list."
              : "Previous reports are kept as history and do not affect the at-risk list."}
          </p>
        </Card>
      ) : null}

      {region.mergedWith.length > 0 ? (
        <Card className="mb-4">
          <h2 className="text-sm font-semibold">
            Merged with {region.mergedWith.length} other{" "}
            {region.mergedWith.length === 1 ? "plot" : "plots"}
          </h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {region.mergedWith.map((m) => (
              <Link
                key={m.wgRegionId}
                href={`/regions/${m.worldUuid}/${encodeURIComponent(m.wgRegionId)}`}
                className="rounded bg-surface-muted px-2 py-1 font-mono text-xs text-accent hover:underline"
              >
                {m.wgRegionId}
              </Link>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            Named together in an eviction report, same owner, and adjacent.
            PSA §18(2) treats a merged plot as one property for eviction, so
            file a single report covering all of them — but §18(1) still counts
            them individually against ownership limits.
          </p>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted">Price</div>
          <div className="mt-1 text-xl font-semibold">
            <Money value={region.price} />
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted">
            Lease ends
          </div>
          <div className="mt-1 text-xl font-semibold">
            <RelativeTime value={region.leaseEndAt} />
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted">Tags</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {region.tags && region.tags.length > 0 ? (
              region.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)
            ) : (
              <span className="text-sm text-muted">none</span>
            )}
          </div>
        </Card>
      </div>

      <Card className="mt-8">
        <details open>
          <summary className="cursor-pointer text-sm font-semibold">
            Inspector report kit
            <span className="ml-2 font-normal text-muted">
              {detected ? (
                <>
                  — {detected.reason.label},{" "}
                  {describeResolveTime(detected.reason.resolveDays)}, eviction{" "}
                  {detected.evictionDateLabel}
                </>
              ) : (
                <>— no automatic reason; pick one to fill the kit</>
              )}
            </span>
          </summary>
          <LinkReport
            worldUuid={region.worldUuid}
            wgRegionId={region.wgRegionId}
            linked={
              openReport
                ? {
                    threadId: openReport.threadId,
                    title: openReport.title,
                    url: openReport.url,
                    source: openReport.source,
                    linkSource: openReport.linkSource,
                  }
                : null
            }
          />
          <ReportKitPanel
            kits={kits}
            detection={detection}
            plotIds={plotIds}
            ownerName={region.ownerName}
          />
        </details>
      </Card>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          Stakeholders
        </h2>
        <Table>
          <thead>
            <tr>
              <Th>Role</Th>
              <Th>Player</Th>
              <Th align="right">30d playtime</Th>
              <Th>Flags</Th>
            </tr>
          </thead>
          <tbody>
            {region.stakeholders.map((s) => (
              <tr key={`${s.role}:${s.playerUuid}`} className="hover:bg-surface-muted">
                <Td>
                  <span className="text-xs text-muted">{s.role}</span>
                </Td>
                <Td>
                  <Link
                    href={`/players/${s.playerUuid}`}
                    className="text-accent hover:underline"
                  >
                    {s.playerName ?? s.playerUuid.slice(0, 8)}
                  </Link>
                </Td>
                <Td align="right">
                  <Duration ms={s.playtime30dMs} />
                </Td>
                <Td>
                  <div className="flex gap-1">
                    {s.isBanned ? <Badge tone="danger">banned</Badge> : null}
                    {s.isDeported ? <Badge tone="danger">deported</Badge> : null}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
    </>
  );
}
