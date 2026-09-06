"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import type { PruneFilters } from "@/lib/insights/prune";

export function Filters({ current }: { current: PruneFilters }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const update = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      router.replace(`/prune?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const setParam = (key: string, value: string) =>
    update((params) => {
      if (value) params.set(key, value);
      else params.delete(key);
    });

  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-4 rounded-lg border border-border-subtle bg-surface p-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Dormant for at least
        </span>
        <span className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            defaultValue={current.inactivityDays}
            onBlur={(e) => setParam("days", e.target.value)}
            className="w-24 rounded border border-border-subtle bg-background px-2 py-1 text-sm"
          />
          <span className="text-sm text-muted">days</span>
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Balance above
        </span>
        <input
          type="number"
          min={0}
          step="1"
          defaultValue={current.minBalance}
          onBlur={(e) => setParam("min", e.target.value)}
          className="w-32 rounded border border-border-subtle bg-background px-2 py-1 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Player name
        </span>
        <input
          type="search"
          placeholder="any"
          defaultValue={current.search ?? ""}
          onBlur={(e) => setParam("q", e.target.value)}
          className="w-48 rounded border border-border-subtle bg-background px-2 py-1 text-sm"
        />
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={current.includeExcluded ?? false}
          onChange={(e) => setParam("excluded", e.target.checked ? "1" : "")}
        />
        Show excluded players
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Sort by
        </span>
        <select
          value={current.sort ?? "balance"}
          onChange={(e) => setParam("sort", e.target.value)}
          className="rounded border border-border-subtle bg-background px-2 py-1 text-sm"
        >
          <option value="balance">Balance</option>
          <option value="last_seen">Last seen</option>
          <option value="registered">Registered</option>
          <option value="player">Name</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Order
        </span>
        <select
          value={current.direction ?? "desc"}
          onChange={(e) => setParam("dir", e.target.value)}
          className="rounded border border-border-subtle bg-background px-2 py-1 text-sm"
        >
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select>
      </label>
    </div>
  );
}
