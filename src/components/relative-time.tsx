"use client";

import { useEffect, useState } from "react";

/**
 * Relative timestamps are computed on the client, after mount.
 *
 * Reading the clock during render is impure: the server and the client would
 * disagree, and any re-render would silently produce a different string. The
 * server renders a fixed absolute date, and this swaps it for "3m ago" once
 * hydrated — so the markup is stable and hydration-safe.
 */

const UNITS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [86_400_000, "day"],
  [3_600_000, "hour"],
  [60_000, "minute"],
  [1_000, "second"],
];

function format(date: Date, now: number): string {
  const diffMs = date.getTime() - now;
  const abs = Math.abs(diffMs);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  for (const [size, unit] of UNITS) {
    if (abs >= size) {
      return formatter.format(Math.round(diffMs / size), unit);
    }
  }
  return "just now";
}

export function RelativeTime({
  value,
  fallback,
}: {
  /** ISO string, so the prop crosses the server/client boundary cleanly. */
  value: string | null;
  /** Absolute rendering used until hydration. */
  fallback: string;
}) {
  const [relative, setRelative] = useState<string | null>(null);

  useEffect(() => {
    if (!value) return;
    const date = new Date(value);
    const tick = () => setRelative(format(date, Date.now()));
    tick();
    // Re-render once a minute so "2m ago" doesn't go stale on an open tab.
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, [value]);

  if (!value) return <span className="text-muted">never</span>;

  return (
    <time dateTime={value} title={value}>
      {relative ?? fallback}
    </time>
  );
}
