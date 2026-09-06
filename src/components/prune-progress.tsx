import { Badge, Card } from "@/components/ui";
import type { PruneBackfillProgress } from "@/lib/insights/prune";

/**
 * Progress of the dormant-roster balance backfill.
 *
 * Shared by `/prune`, where it explains why the list is short, and `/sync`,
 * where it is one long job among many. The backfill runs for the better part of
 * a day, so "how far along, how fast, how much longer" needs to be readable at
 * a glance rather than inferred from a run log.
 */

function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

export function PruneProgress({
  progress,
  className,
}: {
  progress: PruneBackfillProgress;
  className?: string;
}) {
  const percent = progress.ratio * 100;
  // Anything underway should read as underway, not as an empty bar.
  const barWidth = progress.ratio > 0 ? Math.max(percent, 0.5) : 0;
  const complete = progress.pending === 0;

  return (
    <Card className={className}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Balance backfill
        </span>
        {complete ? (
          <Badge tone="ok">Complete</Badge>
        ) : progress.running ? (
          <Badge tone="ok">Running</Badge>
        ) : progress.betweenBatches ? (
          <Badge tone="ok">Cycling</Badge>
        ) : (
          <Badge tone="warn">Idle</Badge>
        )}
        <span className="ml-auto text-lg font-semibold tabular-nums">
          {percent.toFixed(1)}%
        </span>
      </div>

      <div
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-label="Dormant players whose balance is known"
      >
        <div
          className={`h-full rounded-full transition-all ${
            complete ? "bg-ok" : "bg-warn"
          }`}
          style={{ width: `${barWidth}%` }}
        />
      </div>

      <p className="mt-2 text-sm text-muted">
        <strong className="text-foreground tabular-nums">
          {progress.measured.toLocaleString()}
        </strong>{" "}
        priced ·{" "}
        <span className="tabular-nums">
          {progress.noAccount.toLocaleString()}
        </span>{" "}
        no account ·{" "}
        <strong className="text-foreground tabular-nums">
          {progress.pending.toLocaleString()}
        </strong>{" "}
        pending, of {progress.dormant.toLocaleString()} dormant players
      </p>

      {complete ? null : (
        <p className="mt-1 text-sm text-muted">
          {progress.ratePerMinute ? (
            <>
              ≈{Math.round(progress.ratePerMinute)} players/min while running ·{" "}
              {progress.etaHours ? (
                <>
                  <strong className="text-foreground">
                    {formatDuration(progress.etaHours)}
                  </strong>{" "}
                  remaining at that rate
                </>
              ) : null}
            </>
          ) : (
            <>No completed sweep yet, so there is no rate to project from.</>
          )}
        </p>
      )}

      {/*
        Liveness is a separate question from throughput: a healthy rate measured
        from past runs says nothing about whether anything is happening now.
      */}
      <p className="mt-1 text-xs text-muted">
        {progress.pricedRecently.toLocaleString()} priced in the last{" "}
        {progress.windowMinutes} min
        {progress.running && progress.runNote ? (
          <> · {progress.runNote}</>
        ) : null}
        {progress.running && !progress.runNote ? (
          <> · batch starting</>
        ) : null}
        {progress.betweenBatches ? <> · between batches</> : null}
        {!progress.running && !progress.betweenBatches && !complete ? (
          <>
            {" "}
            · sweep is not running; it advances only while the worker is up
          </>
        ) : null}
      </p>

      {progress.lastError ? (
        <p className="mt-1 text-xs text-danger">
          Last run errored: {progress.lastError.slice(0, 200)}
        </p>
      ) : null}
    </Card>
  );
}
