import { Suspense } from "react";
import Link from "next/link";

import {
  Badge,
  Card,
  Duration,
  EmptyState,
  Money,
  PageHeader,
  RelativeTime,
  Stat,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { PruneProgress } from "@/components/prune-progress";
import { PAGE_SIZES, parsePruneFilters } from "@/lib/insights/filters";
import {
  countPruneCandidates,
  findPruneCandidates,
  getPruneBackfillProgress,
  getPruneCoverage,
  type PruneFilters,
  type PruneRow,
} from "@/lib/insights/prune";
import { formatPruneCommand } from "@/lib/insights/prune-command";

import { excludePlayerForm } from "../exclusions/actions";
import { CopyCommand } from "./copy-command";
import { Filters } from "./filters";
import { Pager } from "./pager";

export const dynamic = "force-dynamic";

export default async function PrunePage(props: PageProps<"/prune">) {
  return (
    <>
      <PageHeader
        title="Prune victims"
        description={
          <>
            Dormant players still holding money. A player who has not logged in
            for the threshold period and whose balance is above the floor can be
            pruned, with the balance returned to the government. Last login
            comes from the Analytics roster&apos;s{" "}
            <code className="font-mono text-xs">lastSeen</code>; the balance
            from the Treasury API, which has no bulk endpoint — so balances are
            read one player at a time and the list fills in as that backfill
            runs. Figures here come from the local cache, kept current by a
            background sweep rather than re-read on load; each row shows when its
            balance was last read. Excluded players are hidden by default, the
            same as on the at-risk list.
          </>
        }
      />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <Coverage searchParams={props.searchParams} />
      </Suspense>
      <Suspense
        fallback={<p className="text-sm text-muted">Loading filters…</p>}
      >
        <FilterBar searchParams={props.searchParams} />
      </Suspense>
      <Suspense
        fallback={<p className="mt-6 text-sm text-muted">Querying players…</p>}
      >
        <Candidates searchParams={props.searchParams} />
      </Suspense>
    </>
  );
}

type SearchParams = PageProps<"/prune">["searchParams"];

async function resolveFilters(
  searchParams: SearchParams,
): Promise<PruneFilters> {
  return parsePruneFilters(await searchParams);
}

/**
 * Coverage, shown above the list rather than below it.
 *
 * The list is a lower bound until the backfill finishes: a player we have not
 * priced yet is invisible here, not zero. Reporting "N eligible" on its own
 * would read as the whole answer and quietly understate what is reclaimable, so
 * the proportion actually checked is given the same prominence as the total.
 */
async function Coverage({ searchParams }: { searchParams: SearchParams }) {
  const filters = await resolveFilters(searchParams);
  const [coverage, progress] = await Promise.all([
    getPruneCoverage(filters),
    getPruneBackfillProgress(filters),
  ]);
  const percent = Math.round(coverage.coverageRatio * 100);
  const complete = coverage.pending === 0;

  return (
    <div className="mt-6 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Eligible to prune"
          value={coverage.eligible.toLocaleString()}
          tone={coverage.eligible > 0 ? "warn" : "default"}
          hint={`Dormant ${filters.inactivityDays}d+ with a balance over ${filters.minBalance}`}
        />
        <Stat
          label="Reclaimable"
          value={<Money value={coverage.totalBalance} />}
          tone="warn"
          hint="Sum of eligible balances"
        />
        <Stat
          label="Dormant players"
          value={coverage.dormant.toLocaleString()}
          hint={`No login in ${filters.inactivityDays}+ days`}
        />
        <Stat
          label="Balances known"
          value={`${percent}%`}
          tone={complete ? "ok" : "default"}
          hint={`${coverage.measured.toLocaleString()} priced · ${coverage.noAccount.toLocaleString()} no account · ${coverage.pending.toLocaleString()} pending`}
        />
      </div>

      {complete ? null : (
        <>
          <Card>
            <p className="text-sm text-muted">
              <strong className="text-foreground">
                This list is incomplete.
              </strong>{" "}
              {coverage.pending.toLocaleString()} dormant players have not had
              their balance read yet, so they cannot appear here regardless of
              what they hold. Treasury exposes no bulk balance endpoint, so{" "}
              <code className="font-mono text-xs">treasury.prune.sweep</code>{" "}
              works through them one at a time. Players with no Treasury account
              at all are counted as known: a 404 proves there is nothing to
              reclaim. Full job history is on{" "}
              <Link href="/sync" className="underline hover:text-foreground">
                Sync health
              </Link>
              .
            </p>
          </Card>
          <PruneProgress progress={progress} />
        </>
      )}
    </div>
  );
}

async function FilterBar({ searchParams }: { searchParams: SearchParams }) {
  const filters = await resolveFilters(searchParams);
  return (
    <div className="mt-4">
      <Filters current={filters} />
    </div>
  );
}

interface PageShape {
  total: number;
  page: number;
  pageCount: number;
  size: number;
}

function paging(filters: PruneFilters, total: number): PageShape {
  const size = filters.limit ?? 25;
  return {
    total,
    size,
    page: Math.floor((filters.offset ?? 0) / size) + 1,
    pageCount: Math.max(1, Math.ceil(total / size)),
  };
}

/**
 * The list, served entirely from stored balances.
 *
 * This page used to re-read every displayed balance from Treasury on load, so
 * the copyable command was guaranteed to match the account. That was dropped
 * deliberately. A player who has not logged in for 90 days is not spending, and
 * `treasury.prune.balance.sweep` already re-reads dormant balances that hold
 * money on a 24-hour cycle — so the stored figure is both stable and
 * maintained.
 *
 * What made the live read untenable was contention: it shares one throttle with
 * the backfill, which keeps both treasury concurrency slots busy, and a page
 * load went from ~5s to 82s once the sweep was parallelised. Reading from
 * Postgres instead renders in milliseconds and takes the page off the upstream
 * budget entirely, leaving all of it for the backfill.
 *
 * The trade is that a balance can be up to a day old, so staleness is shown
 * rather than implied: every row carries its "Balance read" timestamp, and any
 * row the refresh sweep has not reached within its own target window is flagged
 * on the row itself.
 */
async function Candidates({ searchParams }: { searchParams: SearchParams }) {
  const filters = await resolveFilters(searchParams);
  const [rows, total] = await Promise.all([
    findPruneCandidates(filters),
    countPruneCandidates(filters),
  ]);

  return (
    <CandidateTable
      rows={rows}
      {...paging(filters, total)}
      minBalance={filters.minBalance}
    />
  );
}

/**
 * The list, with the balances we already hold.
 *
 * Rendered immediately from stored values and streamed over by `FreshRows`
 * once the live re-read finishes. Showing the cached figures beats a spinner:
 * the names, dormancy and rough amounts are what an operator scans first, and
 * those do not change on refresh — only the balance does.
 *
 * The copy button is the exception and is deliberately withheld while
 * `refreshing`. A stale amount is precisely what the live re-read exists to
 * prevent, and a button that silently hands over a figure from yesterday's
 * sweep would undo that. The row is visible; only the irreversible action
 * waits.
 */
function CandidateTable({
  rows,
  total,
  page,
  pageCount,
  size,
  minBalance,
}: {
  rows: PruneRow[];
  total: number;
  page: number;
  pageCount: number;
  size: number;
  minBalance: number | undefined;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState>
        {page > 1 ? (
          <>
            Nothing on page {page}. The list may have shrunk since the link was
            made —{" "}
            <Link href="/prune" className="underline">
              start from page 1
            </Link>
            .
          </>
        ) : (
          <>
            No dormant player currently has a measured balance over {minBalance}
            . If the backfill is still running, that is a statement about what
            has been checked so far, not about the server.
          </>
        )}
      </EmptyState>
    );
  }

  return (
    <div className="mt-6 space-y-3">
      <p className="text-sm text-muted">
        Showing {rows.length.toLocaleString()} of {total.toLocaleString()}{" "}
        eligible {total === 1 ? "player" : "players"} · page {page} of{" "}
        {pageCount.toLocaleString()}
      </p>
      <Table>
        <thead>
          <tr>
            <Th>Player</Th>
            <Th align="right">Balance</Th>
            <Th>Last seen</Th>
            <Th align="right">Dormant</Th>
            <Th align="right">Lifetime playtime</Th>
            <Th align="right">Sessions</Th>
            <Th>Flags</Th>
            <Th>Balance read</Th>
            <Th>Command</Th>
            <Th align="right">Action</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const command = formatPruneCommand(row.playerName, row.balance);
            return (
              <tr key={row.playerUuid}>
                <Td>
                  <Link
                    href={`/players/${row.playerUuid}`}
                    className="hover:underline"
                  >
                    {row.playerName ?? (
                      <span className="font-mono text-xs">
                        {row.playerUuid}
                      </span>
                    )}
                  </Link>
                </Td>
                <Td align="right">
                  {/* Exact decimal string from Postgres numeric — never a float. */}
                  <span className="font-medium tabular-nums">
                    <Money value={row.balance} />
                  </span>
                </Td>
                <Td>
                  <RelativeTime value={row.lastSeenAt} />
                </Td>
                <Td align="right">
                  {row.daysInactive === null
                    ? "—"
                    : `${row.daysInactive.toLocaleString()}d`}
                </Td>
                <Td align="right">
                  <Duration ms={row.lifetimePlaytimeMs} />
                </Td>
                <Td align="right">
                  {row.sessionCount === null
                    ? "—"
                    : row.sessionCount.toLocaleString()}
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    {row.isBanned ? <Badge tone="danger">Banned</Badge> : null}
                    {row.isDeported ? (
                      <Badge tone="warn">Deported</Badge>
                    ) : null}
                    {row.isExcluded ? (
                      <Badge tone="neutral">
                        Excluded
                        {row.exclusionReason ? `: ${row.exclusionReason}` : ""}
                      </Badge>
                    ) : null}
                  </span>
                </Td>
                <Td>
                  <span className="flex items-center gap-1.5">
                    <RelativeTime value={row.balanceSyncedAt} />
                    {row.balanceIsStale ? (
                      <Badge tone="warn">stale</Badge>
                    ) : null}
                  </span>
                </Td>
                <Td>
                  {command ? (
                    <CopyCommand command={command} />
                  ) : (
                    <span
                      className="text-xs text-muted"
                      title="No username on record for this player, and /prune addresses players by name"
                    >
                      no username
                    </span>
                  )}
                </Td>
                <Td align="right">
                  {row.isExcluded ? (
                    <span className="text-xs text-muted">
                      hidden by default
                    </span>
                  ) : (
                    <form action={excludePlayerForm}>
                      <input
                        type="hidden"
                        name="playerUuid"
                        value={row.playerUuid}
                      />
                      <button
                        type="submit"
                        title={`Exclude ${row.playerName ?? "this player"} from review`}
                        className="rounded border border-border-subtle px-2 py-1 text-xs whitespace-nowrap transition-colors hover:bg-surface-muted"
                      >
                        Exclude
                      </button>
                    </form>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <Pager
        page={page}
        pageCount={pageCount}
        size={size}
        sizes={PAGE_SIZES}
      />
    </div>
  );
}
