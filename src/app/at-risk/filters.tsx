"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import type { AtRiskFilters, StakeholderRole } from "@/lib/insights/at-risk";
import { ALL_REASONS, type FlagReason } from "@/lib/insights/reasons";

const REASONS: Array<{ value: FlagReason; label: string }> = [
  { value: "inactive", label: "Inactive" },
  { value: "banned", label: "Banned" },
  { value: "deported", label: "Deported" },
  { value: "over-limit", label: "Over limit" },
];

const ROLES: Array<{ value: StakeholderRole; label: string }> = [
  { value: "titleholder", label: "Titleholder" },
  { value: "landlord", label: "Landlord" },
  { value: "tenant", label: "Tenant" },
];

export function Filters({
  worlds,
  current,
}: {
  worlds: Array<{ uuid: string; name: string | null; regions: number }>;
  current: AtRiskFilters;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const update = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      router.replace(`/at-risk?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const toggleMulti = (key: string, value: string, active: boolean) =>
    update((params) => {
      const values = new Set(params.getAll(key).flatMap((v) => v.split(",")));
      if (active) values.delete(value);
      else values.add(value);
      params.delete(key);
      for (const v of values) if (v) params.append(key, v);
    });

  const activeReasons = new Set(current.reasons ?? ALL_REASONS);
  const activeRoles = new Set(current.roles ?? ["titleholder", "landlord"]);

  const worldLabel =
    worlds.find((w) => w.uuid === current.worldUuid)?.name ?? "all worlds";
  const authorityLabel = current.authority ?? "any authority";
  const narrowed = Boolean(current.worldUuid || current.authority);

  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-4 rounded-lg border border-border-subtle bg-surface p-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Inactive under
        </span>
        <span className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            step={1}
            defaultValue={current.thresholdHours}
            onBlur={(event) =>
              update((params) => params.set("hours", event.target.value))
            }
            className="w-20 rounded border border-border-subtle bg-background px-2 py-1 text-sm"
          />
          <span className="text-sm text-muted">hours / 30 days</span>
        </span>
      </label>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium uppercase tracking-wide text-muted">
          Flags
        </legend>
        <div className="flex gap-1">
          {REASONS.map((reason) => {
            const active = activeReasons.has(reason.value);
            return (
              <button
                key={reason.value}
                type="button"
                onClick={() => toggleMulti("reason", reason.value, active)}
                className={`rounded border px-2 py-1 text-sm transition-colors ${
                  active
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border-subtle text-muted hover:text-foreground"
                }`}
              >
                {reason.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium uppercase tracking-wide text-muted">
          Role
        </legend>
        <div className="flex gap-1">
          {ROLES.map((role) => {
            const active = activeRoles.has(role.value);
            return (
              <button
                key={role.value}
                type="button"
                onClick={() => toggleMulti("role", role.value, active)}
                className={`rounded border px-2 py-1 text-sm transition-colors ${
                  active
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border-subtle text-muted hover:text-foreground"
                }`}
              >
                {role.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <details className="w-full" open={narrowed}>
        <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted">
          Advanced — scope
          {narrowed ? (
            <span className="ml-2 normal-case text-accent">
              {worldLabel} · {authorityLabel}
            </span>
          ) : (
            <span className="ml-2 normal-case">all worlds · any authority</span>
          )}
        </summary>
        <p className="mt-2 text-xs text-muted">
          Defaults to government-held plots in the main world, which is the
          slice that is actually actionable. Set either to &ldquo;all&rdquo; to
          widen.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Authority
        </span>
        <input
          type="search"
          defaultValue={current.authority ?? ""}
          placeholder="name or UUID"
          title="Show only plots under this authority — the granting/oversight party on a freehold, distinct from the titleholder who owns it. Accepts a partial name or a full UUID."
          onBlur={(event) =>
            update((params) => {
              const value = event.target.value.trim();
              // Empty means "any authority", not "back to the default" — the
              // field would otherwise be impossible to clear.
              params.set("authority", value || "all");
            })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="w-44 rounded border border-border-subtle bg-background px-2 py-1 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          World
        </span>
        <select
          defaultValue={current.worldUuid ?? "all"}
          onChange={(event) =>
            update((params) => params.set("world", event.target.value))
          }
          className="rounded border border-border-subtle bg-background px-2 py-1 text-sm"
        >
          <option value="all">All worlds</option>
          {worlds.map((world) => (
            <option key={world.uuid} value={world.uuid}>
              {world.name ?? world.uuid.slice(0, 8)} ({world.regions})
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Contract
        </span>
        <select
          defaultValue={current.contractType ?? ""}
          onChange={(event) =>
            update((params) => {
              if (event.target.value) params.set("contract", event.target.value);
              else params.delete("contract");
            })
          }
          className="rounded border border-border-subtle bg-background px-2 py-1 text-sm"
        >
          <option value="">Any</option>
          <option value="freehold">Freehold</option>
          <option value="leasehold">Leasehold</option>
        </select>
      </label>
          <button
            type="button"
            onClick={() =>
              update((params) => {
                params.set("world", "all");
                params.set("authority", "all");
              })
            }
            className="rounded border border-border-subtle px-2 py-1 text-sm text-muted transition-colors hover:text-foreground"
          >
            Clear scope
          </button>
        </div>
      </details>

      <label
        className="flex items-center gap-2 text-sm"
        title="Include players whose 30-day playtime has never been fetched. Off by default so the count is not inflated by missing data."
      >
        <input
          type="checkbox"
          defaultChecked={current.includeUnknownPlaytime}
          onChange={(event) =>
            update((params) => {
              if (event.target.checked) params.set("unknown", "1");
              else params.delete("unknown");
            })
          }
        />
        <span className="text-muted">Include unmeasured</span>
      </label>

      <label
        className="flex items-center gap-2 text-sm"
        title="Show properties held by players on the exclusion list. Hidden by default."
      >
        <input
          type="checkbox"
          defaultChecked={current.includeExcluded}
          onChange={(event) =>
            update((params) => {
              if (event.target.checked) params.set("excluded", "1");
              else params.delete("excluded");
            })
          }
        />
        <span className="text-muted">Show excluded</span>
      </label>

      <label
        className="flex items-center gap-2 text-sm"
        title="Show plots that already have an open eviction report on the forum. Hidden by default, since they are already being handled."
      >
        <input
          type="checkbox"
          defaultChecked={current.includeReported}
          onChange={(event) =>
            update((params) => {
              if (event.target.checked) params.set("reported", "1");
              else params.delete("reported");
            })
          }
        />
        <span className="text-muted">Show reported</span>
      </label>

      <a
        href={`/api/at-risk/export?${searchParams.toString()}`}
        className="ml-auto rounded border border-border-subtle px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground"
      >
        Export CSV
      </a>
    </div>
  );
}
