"use client";

import { useActionState } from "react";

import { assignReportRegion, type AssignResult } from "./actions";

/**
 * Inline plot assignment for a report the parser could not resolve.
 *
 * Feedback is shown in place rather than swallowed: the two ways this fails —
 * an unknown plot name, or a name that is ambiguous because two plots differ
 * only by case — both need the operator to see *why* and try again.
 */
export function AssignRegion({
  threadId,
  world,
}: {
  threadId: string;
  world: string;
}) {
  const [state, action, pending] = useActionState(
    async (_previous: AssignResult | null, formData: FormData) =>
      assignReportRegion(formData),
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <input type="hidden" name="threadId" value={threadId} />
        <input
          type="text"
          name="regionId"
          placeholder="plot id"
          aria-label={`Plot id in ${world}`}
          title={`Case-insensitive. Matched against plots in ${world}.`}
          className="w-28 rounded border border-border-subtle bg-background px-2 py-1 font-mono text-xs"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-border-subtle px-2 py-1 text-xs transition-colors hover:bg-surface-muted disabled:opacity-50"
        >
          {pending ? "…" : "Link"}
        </button>
      </div>
      {state ? (
        <span className={`text-[10px] ${state.ok ? "text-ok" : "text-danger"}`}>
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
