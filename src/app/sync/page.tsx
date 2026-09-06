import { Suspense } from "react";

import { PruneProgress } from "@/components/prune-progress";

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
import {
  ANALYTICS_BUDGET,
  FORUM_BUDGET,
  PUNISHMENTS_BUDGET,
  REALTY_BUDGET,
} from "@/lib/http/budgets";
import {
  getEvictionFeedHealth,
  getQueue,
  getRecentRuns,
  getSourceHealth,
} from "@/lib/insights/sync-health";
import { getPruneBackfillProgress } from "@/lib/insights/prune";
import { SCHEDULE } from "@/lib/sync/scheduler";

import { getNotifyStatus } from "@/lib/notify/status";

import { retryDeadJobs, resetCircuit, triggerAllProbes, triggerJob } from "./actions";
import { AutoRefresh } from "./auto-refresh";
import { TestWebhookButton } from "./test-webhook";

export const dynamic = "force-dynamic";

/** Configured budgets, for comparison against observed rates. */
const BUDGETS: Record<string, number> = {
  realty: REALTY_BUDGET.groups.default.requestsPerMinute,
  analytics: ANALYTICS_BUDGET.groups.default.requestsPerMinute,
  punishments: PUNISHMENTS_BUDGET.groups.default.requestsPerMinute,
  forum: FORUM_BUDGET.groups.default.requestsPerMinute,
};

export default function SyncPage() {
  return (
    <>
      <PageHeader
        title="Sync health"
        description="Every expensive crawl sits behind a cheap change probe, so a quiet server costs only a handful of requests per hour."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <AutoRefresh />
            <form action={triggerAllProbes}>
              <button
                type="submit"
                className="rounded border border-border-subtle px-3 py-1.5 text-sm transition-colors hover:bg-surface-muted"
              >
                Run all probes now
              </button>
            </form>
          </div>
        }
      />

      <Suspense fallback={<p className="text-sm text-muted">Loading sources…</p>}>
        <Sources />
      </Suspense>

      {/*
        The balance backfill is the one job here measured in hours rather than
        seconds, so it gets its own panel: a run log shows the last batch, not
        how far through 61k players the whole thing is.
      */}
      <Suspense fallback={null}>
        <PruneBackfill />
      </Suspense>

      <Suspense fallback={null}>
        <Schedule />
      </Suspense>

      <Suspense fallback={null}>
        <Queue />
      </Suspense>

      <Suspense fallback={null}>
        <Webhooks />
      </Suspense>

      <Suspense fallback={null}>
        <EvictionFeed />
      </Suspense>

      <Suspense fallback={null}>
        <Runs />
      </Suspense>
    </>
  );
}

async function PruneBackfill() {
  const progress = await getPruneBackfillProgress();
  // Nothing to report before the roster has been read at all.
  if (progress.dormant === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
        Prune balance backfill
      </h2>
      <PruneProgress progress={progress} />
    </section>
  );
}

async function Sources() {
  const sources = await getSourceHealth();

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
        Sources
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {sources.map((source) => {
          const open = source.circuitOpen;
          const budget = BUDGETS[source.source];
          const overBudget = budget !== undefined && source.peakRequestsPerMinute > budget;

          return (
            <Card key={source.source}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{source.source}</span>
                {open ? (
                  <Badge tone="danger">circuit open</Badge>
                ) : source.errorsLastHour > 0 ? (
                  <Badge tone="warn">{source.errorsLastHour} errors/h</Badge>
                ) : (
                  <Badge tone="ok">ok</Badge>
                )}
              </div>
              <dl className="mt-3 space-y-1 text-xs text-muted">
                <div className="flex justify-between gap-2">
                  <dt>Requests (1h)</dt>
                  <dd className="tabular-nums">{source.requestsLastHour}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Peak / min</dt>
                  <dd
                    className={`tabular-nums ${overBudget ? "text-danger" : ""}`}
                    title={
                      budget !== undefined
                        ? `Configured budget: ${budget} req/min`
                        : "Per-endpoint budgets apply"
                    }
                  >
                    {source.peakRequestsPerMinute}
                    {budget !== undefined ? ` / ${budget}` : ""}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Last request</dt>
                  <dd>
                    <RelativeTime value={source.lastRequestAt} />
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Consecutive failures</dt>
                  <dd className="tabular-nums">{source.consecutiveFailures}</dd>
                </div>
              </dl>
              {source.lastError ? (
                <p className="mt-2 line-clamp-3 text-xs text-danger">
                  {source.lastError}
                </p>
              ) : null}
              {open ? (
                <form
                  action={resetCircuit.bind(null, source.source)}
                  className="mt-3"
                >
                  <button
                    type="submit"
                    className="rounded border border-border-subtle px-2 py-1 text-xs transition-colors hover:bg-surface-muted"
                  >
                    Reset circuit
                  </button>
                </form>
              ) : null}
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function Schedule() {
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
        Scheduled probes
      </h2>
      <Table>
        <thead>
          <tr>
            <Th>Job</Th>
            <Th>Source</Th>
            <Th align="right">Every</Th>
            <Th>What it does</Th>
            <Th align="right">Run</Th>
          </tr>
        </thead>
        <tbody>
          {SCHEDULE.map((entry) => (
            <tr key={entry.kind} className="hover:bg-surface-muted">
              <Td mono>{entry.kind}</Td>
              <Td>{entry.source}</Td>
              <Td align="right">{Math.round(entry.everyMs / 60_000)}m</Td>
              <Td>
                <span className="text-xs text-muted">{entry.description}</span>
              </Td>
              <Td align="right">
                <form action={triggerJob.bind(null, entry.kind)}>
                  <button
                    type="submit"
                    className="rounded border border-border-subtle px-2 py-1 text-xs transition-colors hover:bg-surface-muted"
                  >
                    Run
                  </button>
                </form>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

async function Queue() {
  const queue = await getQueue();
  const dead = queue.filter((row) => row.status === "dead");

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Queue
        </h2>
        {dead.length > 0 ? (
          <form action={retryDeadJobs}>
            <button
              type="submit"
              className="rounded border border-danger px-2 py-1 text-xs text-danger transition-colors hover:bg-danger-bg"
            >
              Retry {dead.reduce((n, r) => n + r.count, 0)} dead job(s)
            </button>
          </form>
        ) : null}
      </div>
      {queue.length === 0 ? (
        <EmptyState>Queue is empty — everything is up to date.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Kind</Th>
              <Th>Status</Th>
              <Th align="right">Count</Th>
              <Th>Next run</Th>
            </tr>
          </thead>
          <tbody>
            {queue.map((row) => (
              <tr
                key={`${row.kind}:${row.status}`}
                className="hover:bg-surface-muted"
              >
                <Td mono>{row.kind}</Td>
                <Td>
                  <Badge
                    tone={
                      row.status === "dead"
                        ? "danger"
                        : row.status === "running"
                          ? "ok"
                          : "neutral"
                    }
                  >
                    {row.status}
                  </Badge>
                </Td>
                <Td align="right">{row.count.toLocaleString()}</Td>
                <Td>
                  <RelativeTime value={row.oldestRunAfter} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

/**
 * The forum feed needs a human eye in a way the APIs don't: its thread prefixes
 * are free text, so the resolved-vocabulary in EVICTION_RESOLVED_PREFIXES can
 * only be checked against what actually shows up. Reports naming no known
 * region are listed too — those are titles the parser could not read.
 */
/**
 * Discord alert channels.
 *
 * The panel exists because a silent channel has three very different causes —
 * no URL, no baseline yet, or genuinely nothing to say — and they are
 * indistinguishable from the outside. Each row states which it is, and carries
 * a test button so the URL itself can be checked without waiting for something
 * bad to happen on the server.
 */
async function Webhooks() {
  const channels = await getNotifyStatus();

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
        Discord alerts
      </h2>
      <Table>
        <thead>
          <tr>
            <Th>Channel</Th>
            <Th>Fires on</Th>
            <Th>State</Th>
            <Th align="right">Announced</Th>
            <Th align="right">Last alert</Th>
            <Th align="right">Test</Th>
          </tr>
        </thead>
        <tbody>
          {channels.map((channel) => (
            <tr key={channel.name} className="hover:bg-surface-muted">
              <Td>
                <div>{channel.label}</div>
                <div className="font-mono text-[10px] text-muted">
                  {channel.jobKind}
                </div>
              </Td>
              <Td>
                <span className="text-xs text-muted">{channel.description}</span>
              </Td>
              <Td>
                {!channel.configured ? (
                  <Badge
                    tone="neutral"
                    title={`Set ${channel.envVar} to switch this channel on.`}
                  >
                    not configured
                  </Badge>
                ) : !channel.seeded ? (
                  <Badge
                    tone="warn"
                    title="The next run records everything that already qualifies as known, without announcing it. Alerts start after that."
                  >
                    awaiting baseline
                  </Badge>
                ) : (
                  <Badge tone="ok" title="Baseline recorded; real alerts are live.">
                    live
                  </Badge>
                )}
              </Td>
              <Td align="right">
                <span className="tabular-nums">{channel.sent.toLocaleString()}</span>
                {channel.seededItems > 0 ? (
                  <div
                    className="text-[10px] text-muted"
                    title="Recorded as already known when the channel was switched on, and deliberately not announced."
                  >
                    {channel.seededItems.toLocaleString()} seeded
                  </div>
                ) : null}
              </Td>
              <Td align="right">
                <RelativeTime value={channel.lastSentAt} />
              </Td>
              <Td align="right">
                <TestWebhookButton
                  channel={channel.name}
                  disabled={!channel.configured}
                />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="mt-2 text-xs text-muted">
        A test records nothing and consumes no real alert — it only checks that
        the URL works and that Discord accepts the payload.
      </p>
    </section>
  );
}

async function EvictionFeed() {
  const feed = await getEvictionFeedHealth();
  if (feed.totalReports === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
        Eviction reports
      </h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-xs uppercase tracking-wide text-muted">Reports</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {feed.totalReports}
          </div>
          <div className="mt-1 text-xs text-muted">
            {feed.activeReports} open · {feed.archivedReports} archived ·{" "}
            {feed.linkedRegions} region links
          </div>
          <div className="mt-1 text-xs text-muted">
            Only open reports suppress a plot; archived ones are history.
          </div>
        </Card>
        <Card className="sm:col-span-2">
          <div className="text-xs uppercase tracking-wide text-muted">
            Observed prefixes
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {feed.prefixes.map((p) => (
              <Badge
                key={p.prefix ?? "(none)"}
                tone={p.active > 0 ? "warn" : "neutral"}
                title={`${p.count} reports, ${p.active} counted as active`}
              >
                {p.prefix ?? "(no prefix)"} · {p.count}
              </Badge>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            Anything not listed in EVICTION_RESOLVED_PREFIXES counts as active.
          </p>
        </Card>
      </div>
      {feed.unmatched.length > 0 ? (
        <div className="mt-4">
          <p className="mb-2 text-xs text-warn">
            {feed.unmatched.length} report(s) named no known region — the title
            format may not be parseable:
          </p>
          <ul className="space-y-1 text-xs">
            {feed.unmatched.map((u) => (
              <li key={u.url}>
                <a
                  href={u.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  {u.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

async function Runs() {
  const runs = await getRecentRuns(25);

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
        Recent runs
      </h2>
      {runs.length === 0 ? (
        <EmptyState>No sync runs recorded yet.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Kind</Th>
              <Th>Status</Th>
              <Th align="right">Requests</Th>
              <Th align="right">Items</Th>
              <Th>Started</Th>
              <Th>Note</Th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} className="hover:bg-surface-muted">
                <Td mono>{run.kind}</Td>
                <Td>
                  <Badge
                    tone={
                      run.status === "error"
                        ? "danger"
                        : run.status === "ok"
                          ? "ok"
                          : "neutral"
                    }
                  >
                    {run.status}
                  </Badge>
                </Td>
                <Td align="right">{run.requestsMade}</Td>
                <Td align="right">
                  {run.itemsUpserted}
                  {run.itemsRemoved > 0 ? (
                    <span className="text-danger"> −{run.itemsRemoved}</span>
                  ) : null}
                </Td>
                <Td>
                  <RelativeTime value={run.startedAt} />
                </Td>
                <Td>
                  <span className="text-xs text-muted">
                    {run.error ?? run.note ?? ""}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
