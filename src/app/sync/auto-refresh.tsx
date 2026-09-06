"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

/**
 * Keeps `/sync` current without a manual reload.
 *
 * `router.refresh()` re-runs this route's server components and patches the
 * result in, so scroll position, focus and the open state of anything on the
 * page survive — unlike a meta-refresh or a `location.reload()`.
 *
 * Safe to poll *here* specifically: every query behind `/sync` is a local
 * Postgres read. The same treatment would be wrong on `/prune`, which issues a
 * live Treasury call per displayed row, and would turn a background tab into a
 * steady stream of requests against someone else's game server.
 *
 * Polling stops while the tab is hidden and resumes on return, with an
 * immediate refresh so what you come back to is current rather than however
 * stale it was when you left.
 */
export function AutoRefresh({
  intervalMs = 5_000,
}: {
  intervalMs?: number;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);
  const [pending, startTransition] = useTransition();
  // Elapsed time is held in state and advanced by the ticking effect below,
  // not computed during render: `Date.now()` in a render body makes the
  // component non-idempotent, which the React Compiler rejects outright.
  const [secondsAgo, setSecondsAgo] = useState<number | null>(null);
  const lastUpdated = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const refresh = useCallback(() => {
    startTransition(() => {
      router.refresh();
      lastUpdated.current = Date.now();
      setSecondsAgo(0);
    });
  }, [router]);

  useEffect(() => {
    if (!enabled) return;

    const start = () => {
      clearInterval(timer.current);
      timer.current = setInterval(() => {
        // Belt and braces: an interval can still fire once as a tab is hidden.
        if (!document.hidden) refresh();
      }, intervalMs);
    };

    const onVisibility = () => {
      if (document.hidden) {
        clearInterval(timer.current);
      } else {
        refresh();
        start();
      }
    };

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs, refresh]);

  // Ticks the counter between refreshes so it reads as elapsed time rather
  // than jumping only when new data lands.
  useEffect(() => {
    const tick = setInterval(() => {
      const at = lastUpdated.current;
      if (at !== null) setSecondsAgo(Math.floor((Date.now() - at) / 1000));
    }, 1_000);
    return () => clearInterval(tick);
  }, []);

  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <span
        aria-live="polite"
        className="tabular-nums"
        title={
          enabled
            ? `Refreshing every ${Math.round(intervalMs / 1000)}s while this tab is visible`
            : "Auto-refresh is paused"
        }
      >
        {pending
          ? "updating…"
          : secondsAgo === null
            ? enabled
              ? "live"
              : "paused"
            : `updated ${secondsAgo}s ago`}
      </span>
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${
          enabled ? (pending ? "bg-warn" : "bg-ok") : "bg-surface-muted"
        }`}
      />
      <button
        type="button"
        onClick={() => setEnabled((on) => !on)}
        aria-pressed={enabled}
        className="rounded border border-border-subtle px-2 py-1 transition-colors hover:bg-surface-muted"
      >
        {enabled ? "Pause" : "Resume"}
      </button>
    </div>
  );
}
