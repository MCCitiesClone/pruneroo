import type { ReactNode } from "react";

import { RelativeTime as RelativeTimeClient } from "./relative-time";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>
        ) : null}
      </div>
      {actions}
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-border-subtle bg-surface p-4 ${className}`}
    >
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "danger" | "warn" | "ok";
}) {
  const toneClass =
    tone === "danger"
      ? "text-danger"
      : tone === "warn"
        ? "text-warn"
        : tone === "ok"
          ? "text-ok"
          : "text-foreground";
  return (
    <Card>
      <div className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>
        {value}
      </div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </Card>
  );
}

const BADGE_TONES = {
  danger: "bg-danger-bg text-danger",
  warn: "bg-warn-bg text-warn",
  ok: "bg-ok-bg text-ok",
  neutral: "bg-surface-muted text-muted",
} as const;

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: keyof typeof BADGE_TONES;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="table-scroll rounded-lg border border-border-subtle bg-surface">
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  align = "left",
}: {
  children: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`border-b border-border-subtle px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  mono = false,
}: {
  children: ReactNode;
  align?: "left" | "right";
  mono?: boolean;
}) {
  return (
    <td
      className={`border-b border-border-subtle px-3 py-2 align-top ${
        align === "right" ? "text-right tabular-nums" : ""
      } ${mono ? "font-mono text-xs" : ""}`}
    >
      {children}
    </td>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border-subtle px-6 py-10 text-center text-sm text-muted">
      {children}
    </div>
  );
}

/** Renders a duration in whole hours and minutes; `null` reads as unknown. */
export function Duration({ ms }: { ms: number | null }) {
  if (ms === null) return <span className="text-muted">—</span>;
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return <>{minutes}m</>;
  return (
    <>
      {hours}h {minutes > 0 ? `${minutes}m` : ""}
    </>
  );
}

/**
 * Server-side wrapper: renders a stable absolute date, which the client
 * component upgrades to a relative one after hydration. Reading the clock
 * during render would be impure and produce server/client disagreement.
 */
export function RelativeTime({ value }: { value: Date | string | null }) {
  if (!value) return <span className="text-muted">never</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  const iso = date.toISOString();
  return (
    <RelativeTimeClient
      value={iso}
      fallback={iso.slice(0, 16).replace("T", " ")}
    />
  );
}

/** Money is a decimal string end to end; formatted only for display. */
export function Money({ value }: { value: string | null }) {
  if (value === null) return <span className="text-muted">—</span>;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return <span className="font-mono">{value}</span>;
  return <>{parsed.toLocaleString(undefined, { maximumFractionDigits: 2 })}</>;
}
