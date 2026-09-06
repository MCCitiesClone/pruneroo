"use client";

import { useState } from "react";

import {
  describeResolveTime,
  REPORT_REASONS,
  type ReasonDetection,
  type ReportKit,
  type ReportReason,
} from "@/lib/insights/report-kit";

/**
 * The filing kit, with copy buttons.
 *
 * Client-side because copying to the clipboard is the whole point: an inspector
 * files a report by pasting these values into the forum form, and re-typing a
 * username or recomputing an eviction date by hand is where mistakes come from.
 */
function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="rounded border border-border-subtle px-1.5 py-0.5 text-[10px] whitespace-nowrap transition-colors hover:bg-surface-muted"
      aria-label={label ? `Copy ${label}` : "Copy"}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2 border-b border-border-subtle py-1.5 last:border-0">
      <span className="text-xs text-muted">{label}</span>
      <span className="flex items-center gap-2 text-right">
        <code className="font-mono text-xs">{value}</code>
        <CopyButton value={value} label={label} />
      </span>
    </div>
  );
}

export function ReportKitPanel({
  kits,
  detection,
  plotIds,
  ownerName,
}: {
  kits: Record<ReportReason, ReportKit>;
  detection: ReasonDetection;
  plotIds: string[];
  ownerName: string | null;
}) {
  // Pre-selected when the data decides it. When it does not — Eyesore, Lack of
  // Progress and Non-Compliance are judgements about a build nothing here has
  // seen — the inspector picks, and the kit fills in from that choice.
  const [reason, setReason] = useState<ReportReason | null>(detection.reason);
  const kit = reason ? kits[reason] : null;

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-1">
        {REPORT_REASONS.map((value) => {
          const active = value === reason;
          const detected = value === detection.reason;
          const alsoApplies = detection.also.some((a) => a.reason === value);
          return (
            <button
              key={value}
              type="button"
              onClick={() => setReason(value)}
              title={
                detected
                  ? (detection.basis ?? undefined)
                  : alsoApplies
                    ? detection.also.find((a) => a.reason === value)?.basis
                    : undefined
              }
              className={`rounded border px-2 py-1 text-sm transition-colors ${
                active
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border-subtle text-muted hover:text-foreground"
              }`}
            >
              {kits[value].reason.label}
              {detected || alsoApplies ? (
                <span className="ml-1 text-[10px] uppercase tracking-wide">
                  {detected ? "detected" : "also"}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-xs text-muted">
        {detection.reason ? (
          <>
            <span className="text-foreground">Detected:</span>{" "}
            {kits[detection.reason].reason.label} — {detection.basis}
            {detection.also.length > 0 ? (
              <>
                {" "}
                {detection.also
                  .map((a) => `${kits[a.reason].reason.label} also applies: ${a.basis}`)
                  .join(" ")}
              </>
            ) : null}
          </>
        ) : (
          <>
            Nothing in the data calls for a report — the holder is active and
            within their plot limits. Eyesore, Lack of Progress and
            Non-Compliance are judgements about the build itself, so pick one
            above if you are filing on those grounds.
          </>
        )}
      </p>

      {kit ? (
        <KitFields kit={kit} plotIds={plotIds} ownerName={ownerName} />
      ) : null}
    </div>
  );
}

function KitFields({
  kit,
  plotIds,
  ownerName,
}: {
  kit: ReportKit;
  plotIds: string[];
  ownerName: string | null;
}) {
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Report fields
        </h3>
        <div className="mt-1">
          <Field label="Plot number" value={plotIds.join("/")} />
          <Field label="Eviction date" value={kit.evictionDateLabel} />
          <Field label="Plot owner" value={ownerName ?? "unknown"} />
          <Field label="Reason" value={kit.reason.label} />
          <Field label="Suggested title" value={kit.suggestedTitle} />
        </div>
        <p className="mt-1 text-[10px] text-muted">
          {kit.reason.label}: {describeResolveTime(kit.reason.resolveDays)}.
          {kit.reason.resolveDays === 0
            ? " The policy evicts on the date filed, so the eviction date is today."
            : ""}
        </p>

        <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">
          How to resolve
        </h3>
        <div className="mt-1 flex items-start gap-2">
          <p className="flex-1 text-xs text-muted">{kit.reason.resolution}</p>
          <CopyButton value={kit.reason.resolution} label="resolution text" />
        </div>

        <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">
          Criteria
        </h3>
        <ul className="mt-1 space-y-1">
          {kit.reason.criteria.map((item) => (
            <li key={item} className="text-xs text-muted">
              {item}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Commands
        </h3>
        <ul className="mt-1 space-y-2">
          {kit.commands.map((command) => (
            <li key={command.command}>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">
                  {command.command}
                </code>
                <CopyButton value={command.command} label={command.label} />
              </div>
              <p className="mt-0.5 text-[10px] text-muted">{command.note}</p>
            </li>
          ))}
        </ul>

        <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">
          Evidence required
        </h3>
        <ul className="mt-1 space-y-1">
          {kit.reason.evidence.map((item) => (
            <li key={item} className="flex items-start gap-2 text-xs text-muted">
              <span aria-hidden className="mt-0.5">
                ☐
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
