import { Suspense } from "react";
import Link from "next/link";

import { Card, PageHeader, Stat } from "@/components/ui";
import { getEnv } from "@/lib/env";
import { getOverviewStats } from "@/lib/insights/at-risk";
import { getBackfillProgress } from "@/lib/insights/sync-health";

export const dynamic = "force-dynamic";

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        description="Realty, Economy, Analytics and Punishments data reconciled on Minecraft UUID into a single local cache."
      />
      {/* Sibling boundaries so the shell streams before either query resolves. */}
      <Suspense fallback={<StatsSkeleton />}>
        <Stats />
      </Suspense>
      <Suspense fallback={null}>
        <Backfill />
      </Suspense>
    </>
  );
}

function StatsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-lg border border-border-subtle bg-surface-muted"
        />
      ))}
    </div>
  );
}

async function Stats() {
  const env = getEnv();
  const stats = await getOverviewStats(env.INACTIVITY_THRESHOLD_HOURS);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        label="At-risk properties"
        value={stats.atRiskProperties.toLocaleString()}
        tone={stats.atRiskProperties > 0 ? "danger" : "ok"}
        hint={
          <Link href="/at-risk" className="text-accent hover:underline">
            {stats.distinctAtRiskPlayers.toLocaleString()} distinct holders →
          </Link>
        }
      />
      <Stat
        label="Over a plot limit"
        value={stats.overLimitProperties.toLocaleString()}
        tone={stats.overLimitProperties > 0 ? "warn" : "ok"}
        hint={
          <Link
            href="/at-risk?reason=over-limit"
            className="text-accent hover:underline"
          >
            PSA §17 — plot limits →
          </Link>
        }
      />
      <Stat
        label="Registered plots"
        value={stats.regions.toLocaleString()}
        hint={`${stats.regionsWithDetail.toLocaleString()} with full detail`}
      />
      <Stat label="Known players" value={stats.players.toLocaleString()} />
      <Stat
        label="Active bans"
        value={stats.activeBans.toLocaleString()}
        tone="danger"
      />
      <Stat
        label="Active deportations"
        value={stats.activeDeportations.toLocaleString()}
        tone="danger"
        hint={`indefinite or 4+ months; ${stats.limitedDeportations.toLocaleString()} shorter ones are not grounds to evict`}
      />
      <Stat
        label="Playtime measured"
        value={stats.playtimeCoverage.measured.toLocaleString()}
        tone="ok"
        hint="Fetched from /v1/player"
      />
      <Stat
        label="Playtime inferred zero"
        value={stats.playtimeCoverage.inferredZero.toLocaleString()}
        hint="Last seen over 30 days ago — exact, no request needed"
      />
      <Stat
        label="Excluded from review"
        value={stats.excludedProperties.toLocaleString()}
        hint={
          <Link href="/exclusions" className="text-accent hover:underline">
            {stats.excludedPlayers.toLocaleString()} excluded players →
          </Link>
        }
      />
      <Stat
        label="Under eviction report"
        value={stats.reportedProperties.toLocaleString()}
        hint={`${stats.activeReports.toLocaleString()} open reports — already being handled`}
      />
      <Stat
        label="Playtime unmeasured"
        value={stats.playtimeCoverage.unknown.toLocaleString()}
        tone={stats.playtimeCoverage.unknown > 0 ? "warn" : "ok"}
        hint="Excluded from inactivity results"
      />
    </div>
  );
}

async function Backfill() {
  const progress = await getBackfillProgress();
  if (progress.total === 0 || progress.withDetail >= progress.total) return null;

  const percent = Math.round((progress.withDetail / progress.total) * 100);
  return (
    <Card className="mt-6">
      <div className="flex items-baseline justify-between gap-4">
        <div className="text-sm font-medium">Region detail backfill</div>
        <div className="text-sm tabular-nums text-muted">
          {progress.withDetail.toLocaleString()} /{" "}
          {progress.total.toLocaleString()} ({percent}%)
        </div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-muted">
        <div
          className="h-full rounded-full bg-accent transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-muted">
        Realty exposes ownership only through a per-region endpoint, so the first
        pass fetches each plot once at the configured rate limit. Ownership-based
        insights are incomplete until this finishes.
      </p>
    </Card>
  );
}
