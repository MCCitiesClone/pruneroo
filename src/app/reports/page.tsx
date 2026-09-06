import { Suspense } from "react";
import Link from "next/link";

import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  RelativeTime,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { getEnv } from "@/lib/env";
import {
  getReportCounts,
  listReports,
  type ReportFilter,
} from "@/lib/insights/reports";

import { AssignRegion } from "./assign";
import { unassignReportRegion } from "./actions";

export const dynamic = "force-dynamic";

const TABS: Array<{ value: ReportFilter; label: string }> = [
  { value: "unmatched", label: "Needs a plot" },
  { value: "open", label: "Open" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];

export default function ReportsPage(props: PageProps<"/reports">) {
  return (
    <>
      <PageHeader
        title="Eviction reports"
        description="Reports are matched to plots by reading ids out of the thread title. Anything the parser could not resolve lands here to be assigned by hand — otherwise the report would link nowhere and quietly do nothing."
      />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <Counts />
      </Suspense>
      <Suspense fallback={null}>
        <Reports searchParams={props.searchParams} />
      </Suspense>
    </>
  );
}

async function Counts() {
  const counts = await getReportCounts();
  return (
    <div className="grid gap-4 sm:grid-cols-4">
      <Card>
        <div className="text-xs uppercase tracking-wide text-muted">Open</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">
          {counts.open.toLocaleString()}
        </div>
        <div className="mt-1 text-xs text-muted">suppress their plots</div>
      </Card>
      <Card>
        <div className="text-xs uppercase tracking-wide text-muted">Archived</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">
          {counts.archived.toLocaleString()}
        </div>
        <div className="mt-1 text-xs text-muted">history only</div>
      </Card>
      <Card>
        <div className="text-xs uppercase tracking-wide text-muted">
          Needs a plot
        </div>
        <div
          className={`mt-1 text-2xl font-semibold tabular-nums ${
            counts.unmatched > 0 ? "text-warn" : "text-ok"
          }`}
        >
          {counts.unmatched.toLocaleString()}
        </div>
        <div className="mt-1 text-xs text-muted">
          no region matched
          {counts.staleUnmatched > 0
            ? ` · ${counts.staleUnmatched} older than a year, ignored`
            : ""}
        </div>
      </Card>
      <Card>
        <div className="text-xs uppercase tracking-wide text-muted">
          Manually linked
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">
          {counts.manualLinks.toLocaleString()}
        </div>
        <div className="mt-1 text-xs text-muted">never overwritten by a sync</div>
      </Card>
    </div>
  );
}

async function Reports({
  searchParams,
}: Pick<PageProps<"/reports">, "searchParams">) {
  const params = await searchParams;
  const raw = params.filter;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const filter: ReportFilter = TABS.some((t) => t.value === value)
    ? (value as ReportFilter)
    : "unmatched";

  const [rows, world] = await Promise.all([
    listReports(filter),
    Promise.resolve(getEnv().FORUM_REGION_WORLD),
  ]);

  return (
    <div className="mt-6">
      <nav className="mb-4 flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <Link
            key={tab.value}
            href={`/reports?filter=${tab.value}`}
            className={`rounded border px-3 py-1 text-sm transition-colors ${
              tab.value === filter
                ? "border-accent bg-accent/10 text-accent"
                : "border-border-subtle text-muted hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <EmptyState>
          {filter === "unmatched"
            ? "Every report is linked to at least one plot."
            : "No reports match this filter."}
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Report</Th>
              <Th>Status</Th>
              <Th>Plots</Th>
              <Th>Eviction</Th>
              <Th>Assign a plot</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((report) => (
              <tr key={report.threadId} className="hover:bg-surface-muted">
                <Td>
                  <a
                    href={report.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    {report.title}
                  </a>
                  <div className="mt-0.5 text-[10px] text-muted">
                    {report.author ? `${report.author} · ` : ""}
                    <RelativeTime value={report.postedAt} />
                  </div>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Badge tone={report.isActive ? "warn" : "neutral"}>
                      {report.prefix ?? (report.isActive ? "open" : "closed")}
                    </Badge>
                    {report.feed === "archive" ? (
                      <Badge tone="neutral">archived</Badge>
                    ) : null}
                  </div>
                </Td>
                <Td>
                  {report.regions.length === 0 ? (
                    <span className="text-xs text-warn">none matched</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {report.regions.map((region) => (
                        <span
                          key={`${region.worldUuid}:${region.wgRegionId}`}
                          className="inline-flex items-center gap-1 rounded bg-surface-muted px-1.5 py-0.5 text-xs"
                        >
                          <Link
                            href={`/regions/${region.worldUuid}/${encodeURIComponent(region.wgRegionId)}`}
                            className="font-mono text-accent hover:underline"
                          >
                            {region.wgRegionId}
                          </Link>
                          {region.source === "manual" ? (
                            <span
                              className="text-[10px] text-muted"
                              title="Assigned by hand; a sync will never remove it"
                            >
                              manual
                            </span>
                          ) : null}
                          <form
                            action={unassignReportRegion.bind(
                              null,
                              report.threadId,
                              region.worldUuid,
                              region.wgRegionId,
                            )}
                          >
                            <button
                              type="submit"
                              title="Unlink this plot"
                              className="text-muted transition-colors hover:text-danger"
                            >
                              ×
                            </button>
                          </form>
                        </span>
                      ))}
                    </div>
                  )}
                </Td>
                <Td>
                  <RelativeTime value={report.evictionDate} />
                </Td>
                <Td>
                  <AssignRegion threadId={report.threadId} world={world} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
