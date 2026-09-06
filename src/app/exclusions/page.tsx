import { Suspense } from "react";
import Link from "next/link";

import {
  EmptyState,
  PageHeader,
  RelativeTime,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { getEnv } from "@/lib/env";
import { listExclusions } from "@/lib/insights/exclusions";
import { HOUR_MS } from "@/lib/sources/analytics/duration";

import { includePlayer } from "./actions";

export const dynamic = "force-dynamic";

export default function ExclusionsPage() {
  return (
    <>
      <PageHeader
        title="Excluded players"
        description="Properties held by these players are hidden from the at-risk list. Exclusions are operator decisions — a sync never adds or removes them, so they survive every re-crawl."
      />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <List />
      </Suspense>
    </>
  );
}

async function List() {
  const env = getEnv();
  const rows = await listExclusions(env.INACTIVITY_THRESHOLD_HOURS * HOUR_MS);

  if (rows.length === 0) {
    return (
      <EmptyState>
        No players are excluded. Use the <strong>Exclude</strong> button on a row
        in{" "}
        <Link href="/at-risk" className="text-accent underline">
          at-risk properties
        </Link>{" "}
        to add one.
      </EmptyState>
    );
  }

  const hidden = rows.reduce((sum, row) => sum + row.hiddenProperties, 0);

  return (
    <>
      <p className="mb-3 text-sm text-muted">
        {rows.length} excluded {rows.length === 1 ? "player" : "players"}, hiding{" "}
        {hidden} flagged {hidden === 1 ? "property" : "properties"}.
      </p>
      <Table>
        <thead>
          <tr>
            <Th>Player</Th>
            <Th align="right">Hidden properties</Th>
            <Th>Reason</Th>
            <Th>Excluded</Th>
            <Th align="right">Action</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.playerUuid} className="hover:bg-surface-muted">
              <Td>
                <Link
                  href={`/players/${row.playerUuid}`}
                  className="text-accent hover:underline"
                >
                  {row.playerName ?? row.playerUuid.slice(0, 8)}
                </Link>
              </Td>
              <Td align="right">{row.hiddenProperties}</Td>
              <Td>
                {row.reason ? (
                  row.reason
                ) : (
                  <span className="text-muted">—</span>
                )}
              </Td>
              <Td>
                <RelativeTime value={row.excludedAt} />
              </Td>
              <Td align="right">
                <form action={includePlayer.bind(null, row.playerUuid)}>
                  <button
                    type="submit"
                    className="rounded border border-border-subtle px-2 py-1 text-xs transition-colors hover:bg-surface-muted"
                  >
                    Re-include
                  </button>
                </form>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
