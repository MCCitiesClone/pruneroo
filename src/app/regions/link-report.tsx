"use client";

import { useActionState, useState, useTransition } from "react";

import {
  linkEvictionReport,
  unlinkEvictionReport,
  type LinkResult,
} from "./actions";

/**
 * Paste the filed report's link back onto its plot.
 *
 * This is the last step of the filing loop the kit above sets up: the inspector
 * copies the fields into the forum, posts the thread, and pastes its URL here.
 * That marks the plot as reported — which drops it off the at-risk list — and
 * fills the report link into `/dct-eviction-notice add`, the one field in the
 * kit that cannot be known before the thread exists.
 *
 * Feedback is shown in place because every failure here is one the operator can
 * fix from what it says: a link to the wrong site, a thread that does not
 * exist, or a login that has expired.
 */
export function LinkReport({
  worldUuid,
  wgRegionId,
  linked,
}: {
  worldUuid: string;
  wgRegionId: string;
  /** The open report already attached to this plot, if there is one. */
  linked: {
    threadId: string;
    title: string;
    url: string;
    source: string;
    linkSource: string;
  } | null;
}) {
  const [state, action, pending] = useActionState(
    async (_previous: LinkResult | null, formData: FormData) =>
      linkEvictionReport(formData),
    null,
  );
  const [unlinking, startUnlink] = useTransition();
  const [confirming, setConfirming] = useState(false);

  if (linked) {
    return (
      <div className="mt-3 rounded border border-border-subtle bg-surface-muted/50 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-xs text-muted">
            Filed report{" "}
            <a
              href={linked.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              {linked.title}
            </a>
            {linked.source === "manual" ? (
              <span
                className="ml-1 text-[10px] uppercase tracking-wide text-warn"
                title="Added from a pasted link and not yet seen by a forum sync — the title and eviction date will fill in on the next crawl."
              >
                provisional
              </span>
            ) : null}
          </span>
          {linked.linkSource === "manual" ? (
            confirming ? (
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={unlinking}
                  onClick={() =>
                    startUnlink(async () => {
                      await unlinkEvictionReport(
                        linked.threadId,
                        worldUuid,
                        wgRegionId,
                      );
                      setConfirming(false);
                    })
                  }
                  className="rounded border border-danger/50 px-2 py-0.5 text-[10px] text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                >
                  {unlinking ? "…" : "confirm unlink"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded border border-border-subtle px-2 py-0.5 text-[10px] transition-colors hover:bg-surface-muted"
                >
                  cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                title="Remove this link. The plot returns to the at-risk list."
                className="rounded border border-border-subtle px-2 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-muted"
              >
                unlink
              </button>
            )
          ) : (
            <span
              className="text-[10px] text-muted"
              title="Matched from the thread title by the forum sync. Unlink it on /reports if it is wrong."
            >
              matched by sync
            </span>
          )}
        </div>
        <p className="mt-1 text-[10px] text-muted">
          This plot is marked as reported and is hidden from the at-risk list
          while the report is open.
        </p>
      </div>
    );
  }

  return (
    <form
      action={action}
      className="mt-3 rounded border border-border-subtle p-3"
    >
      <label
        htmlFor="report-url"
        className="text-xs font-semibold text-foreground"
      >
        Link the filed report
      </label>
      <p className="mt-0.5 text-[10px] text-muted">
        Paste the thread URL once you have posted it. Marks the plot as
        reported, pulls the thread in, and fills the link into{" "}
        <code className="font-mono">/dct-eviction-notice add</code>.
      </p>
      <div className="mt-2 flex items-center gap-1">
        <input type="hidden" name="worldUuid" value={worldUuid} />
        <input type="hidden" name="wgRegionId" value={wgRegionId} />
        <input
          id="report-url"
          type="text"
          name="url"
          inputMode="url"
          placeholder="https://www.democracycraft.net/threads/…"
          className="flex-1 rounded border border-border-subtle bg-background px-2 py-1 font-mono text-xs"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-border-subtle px-2 py-1 text-xs whitespace-nowrap transition-colors hover:bg-surface-muted disabled:opacity-50"
        >
          {pending ? "linking…" : "Link report"}
        </button>
      </div>
      {state ? (
        <p
          className={`mt-1 text-[10px] ${state.ok ? "text-ok" : "text-danger"}`}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
