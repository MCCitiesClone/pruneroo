import { Suspense } from "react";
import Link from "next/link";

import {
  Badge,
  Duration,
  EmptyState,
  PageHeader,
  RelativeTime,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { searchPlayers } from "@/lib/insights/player";

export const dynamic = "force-dynamic";

export default function PlayersPage(props: PageProps<"/players">) {
  return (
    <>
      <PageHeader
        title="Players"
        description="Search by name. With no query, shows players who hold property or carry an active punishment."
      />
      <form method="get" className="mb-6">
        <input
          type="search"
          name="q"
          placeholder="Player name…"
          className="w-full max-w-sm rounded border border-border-subtle bg-background px-3 py-1.5 text-sm"
        />
      </form>
      <Suspense fallback={<p className="text-sm text-muted">Searching…</p>}>
        <Results searchParams={props.searchParams} />
      </Suspense>
    </>
  );
}

async function Results({
  searchParams,
}: Pick<PageProps<"/players">, "searchParams">) {
  const params = await searchParams;
  const raw = params.q;
  const query = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  const rows = await searchPlayers(query);

  if (rows.length === 0) {
    return <EmptyState>No players matched.</EmptyState>;
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Player</Th>
          <Th align="right">Holdings</Th>
          <Th align="right">30d playtime</Th>
          <Th>Last seen</Th>
          <Th>Flags</Th>
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
            <Td align="right">{row.holdings}</Td>
            <Td align="right">
              <Duration ms={row.playtime30dMs} />
              {row.playtime30dSource === "unknown" ? (
                <div className="text-[10px] text-warn">unmeasured</div>
              ) : null}
            </Td>
            <Td>
              <RelativeTime value={row.lastSeenAt} />
            </Td>
            <Td>
              <div className="flex gap-1">
                {row.isBanned ? <Badge tone="danger">banned</Badge> : null}
                {row.isDeported ? <Badge tone="danger">deported</Badge> : null}
              </div>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
