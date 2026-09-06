import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  Badge,
  Card,
  Duration,
  EmptyState,
  Money,
  PageHeader,
  RelativeTime,
  Stat,
  Table,
  Td,
  Th,
} from "@/components/ui";
import {
  getPlayerHoldings,
  getPlayerProfile,
  getPlayerPunishments,
} from "@/lib/insights/player";
import { isExcluded } from "@/lib/insights/exclusions";
import { describeExempt, getHolderLimits } from "@/lib/insights/limits";
import { categoryDefinition } from "@/lib/plots/categories";
import { getRealtorMark } from "@/lib/insights/realtors";

import { excludePlayerForm, includePlayer } from "../../exclusions/actions";
import { markRealtorForm, unmarkRealtor } from "../actions";

export const dynamic = "force-dynamic";

export default async function PlayerPage(props: PageProps<"/players/[uuid]">) {
  const { uuid } = await props.params;
  const [profile, excluded, realtor] = await Promise.all([
    getPlayerProfile(uuid),
    isExcluded(uuid),
    getRealtorMark(uuid),
  ]);
  if (!profile) notFound();

  return (
    <>
      <PageHeader
        title={profile.playerName ?? "Unknown player"}
        description={<code className="font-mono text-xs">{profile.playerUuid}</code>}
        actions={
          <div className="flex items-center gap-2">
            {profile.isBanned ? <Badge tone="danger">banned</Badge> : null}
            {profile.isDeported ? <Badge tone="danger">deported</Badge> : null}
            {excluded ? <Badge tone="neutral">excluded</Badge> : null}
            {realtor ? (
              <Badge
                tone="ok"
                title={realtor.note ?? "Realtor job confirmed; §17(9) adds 5 to most plot limits."}
              >
                realtor
              </Badge>
            ) : null}
            {excluded ? (
              <form action={includePlayer.bind(null, uuid)}>
                <button
                  type="submit"
                  className="rounded border border-border-subtle px-3 py-1.5 text-sm transition-colors hover:bg-surface-muted"
                >
                  Re-include in review
                </button>
              </form>
            ) : (
              <form action={excludePlayerForm} className="flex items-center gap-2">
                <input type="hidden" name="playerUuid" value={uuid} />
                <input
                  type="text"
                  name="reason"
                  placeholder="reason (optional)"
                  className="w-44 rounded border border-border-subtle bg-background px-2 py-1.5 text-sm"
                />
                <button
                  type="submit"
                  title="Hide this player's properties from the at-risk list"
                  className="rounded border border-border-subtle px-3 py-1.5 text-sm whitespace-nowrap transition-colors hover:bg-surface-muted"
                >
                  Exclude
                </button>
              </form>
            )}
            <RealtorControl uuid={uuid} marked={realtor !== null} />
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Playtime (30d)"
          value={<Duration ms={profile.playtime30dMs} />}
          hint={
            profile.playtime30dSource === "analytics_detail" ? (
              <>
                measured <RelativeTime value={profile.playtime30dFetchedAt} />
              </>
            ) : profile.playtime30dSource === "inferred_zero" ? (
              "inferred: last seen over 30 days ago"
            ) : (
              "not yet measured"
            )
          }
          tone={profile.playtime30dSource === "unknown" ? "warn" : "default"}
        />
        <Stat
          label="Lifetime playtime"
          value={<Duration ms={profile.lifetimePlaytimeMs} />}
          hint={
            profile.sessionCount !== null
              ? `${profile.sessionCount.toLocaleString()} sessions`
              : undefined
          }
        />
        <Stat
          label="Last seen"
          value={<RelativeTime value={profile.lastSeenAt} />}
          hint={
            profile.registeredAt ? (
              <>
                joined <RelativeTime value={profile.registeredAt} />
              </>
            ) : undefined
          }
        />
        <Stat
          label="Balance"
          value={<Money value={profile.balance} />}
          hint={
            profile.treasuryAccountId
              ? `account ${profile.treasuryAccountId}`
              : "no Treasury account resolved"
          }
        />
      </div>

      {profile.isBanned || profile.isDeported ? (
        <Card className="mt-6 border-danger/40">
          <h2 className="text-sm font-semibold">Active enforcement</h2>
          <dl className="mt-2 space-y-1 text-sm">
            {profile.banReason ? (
              <div>
                <dt className="inline text-muted">Ban: </dt>
                <dd className="inline">{profile.banReason}</dd>
              </div>
            ) : null}
            {profile.deportationReason ? (
              <div>
                <dt className="inline text-muted">Deportation: </dt>
                <dd className="inline">
                  {profile.deportationReason}
                  {profile.deportationKind === "indefinite" ? (
                    <span className="ml-1 text-muted">
                      — indefinite, so their property is at risk.
                    </span>
                  ) : profile.isLongDeported ? (
                    <span className="ml-1 text-muted">
                      — four months or more, so their property is at risk.
                    </span>
                  ) : (
                    <span className="ml-1 text-muted">
                      — under four months, so their property is{" "}
                      <strong>not</strong> at risk on these grounds; they serve
                      it and return.
                    </span>
                  )}
                </dd>
              </div>
            ) : null}
          </dl>
        </Card>
      ) : null}

      <Suspense fallback={null}>
        <Limits uuid={uuid} />
      </Suspense>
      <Suspense fallback={null}>
        <Holdings uuid={uuid} />
      </Suspense>
      <Suspense fallback={null}>
        <Punishments uuid={uuid} />
      </Suspense>
    </>
  );
}

/**
 * Marking a realtor is what turns "check realtor status" into a verdict, so the
 * control sits next to the badge it changes rather than on a settings page.
 * `/about <player>` in game is the only way to confirm the job.
 */
function RealtorControl({ uuid, marked }: { uuid: string; marked: boolean }) {
  if (marked) {
    return (
      <form action={unmarkRealtor.bind(null, uuid)}>
        <button
          type="submit"
          title="Remove the realtor mark. Plot limits revert to the standard §17 caps."
          className="rounded border border-border-subtle px-3 py-1.5 text-sm whitespace-nowrap transition-colors hover:bg-surface-muted"
        >
          Not a realtor
        </button>
      </form>
    );
  }

  return (
    <form action={markRealtorForm} className="flex items-center gap-2">
      <input type="hidden" name="playerUuid" value={uuid} />
      <input
        type="text"
        name="note"
        placeholder="how confirmed (optional)"
        className="w-44 rounded border border-border-subtle bg-background px-2 py-1.5 text-sm"
      />
      <button
        type="submit"
        title="Confirmed with /about as holding the realtor job. PSA §17(9) then allows 5 more of each limited plot type, excluding black market, ranch and Government Subsidised spaces."
        className="rounded border border-border-subtle px-3 py-1.5 text-sm whitespace-nowrap transition-colors hover:bg-surface-muted"
      >
        Mark realtor
      </button>
    </form>
  );
}

/**
 * Holdings measured against the §17 limits — the same counts the at-risk table
 * flags on, shown here because this page is where the realtor question gets
 * answered.
 */
async function Limits({ uuid }: { uuid: string }) {
  const limits = await getHolderLimits(uuid);
  if (!limits) return null;

  const notable = limits.categories.filter(
    (c) => c.overLimit || c.limit !== null,
  );
  if (notable.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
        Plot limits
      </h2>
      <div className="flex flex-wrap gap-2">
        {notable.map((c) => {
          const exempt = describeExempt(c);
          return (
            <div
              key={c.category}
              title={c.note}
              className={`rounded border px-3 py-2 ${
                c.isViolation
                  ? "border-danger/50 bg-danger/5"
                  : c.needsRealtorCheck
                    ? "border-warn/50 bg-warn/5"
                    : "border-border-subtle"
              }`}
            >
              <div className="text-xs text-muted">{c.label}</div>
              <div className="font-mono text-sm tabular-nums">
                {c.count}
                {c.limit !== null ? ` / ${c.limit}` : ""}
                {c.realtorLimit !== null && limits.isRealtor
                  ? ` (realtor ${c.realtorLimit})`
                  : ""}
              </div>
              {c.needsRealtorCheck ? (
                <div className="mt-0.5 text-[10px] text-warn">
                  allowed if realtor (≤{c.realtorLimit})
                </div>
              ) : null}
              {exempt ? (
                <div className="mt-0.5 text-[10px] text-muted">{exempt}</div>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted">
        Counted across every world, since §17 caps total holdings. Merged plots
        count as their individual sub-plots (§18(1)).
      </p>
    </section>
  );
}

async function Holdings({ uuid }: { uuid: string }) {
  const { holdings, hidden } = await getPlayerHoldings(uuid);

  return (
    <section className="mt-8">
      <h2 className="mb-3 flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
        Property ({holdings.length})
        {hidden > 0 ? (
          <span
            className="text-xs font-normal normal-case"
            title="Sub-regions of a plot rather than plots: regions with no tags (billboards, yacht berths, shop units) and regions tagged only 'apartment'. None of them carries zoning, so none counts towards a limit."
          >
            {hidden} sub-region{hidden === 1 ? "" : "s"} hidden
          </span>
        ) : null}
      </h2>
      {holdings.length === 0 ? (
        <EmptyState>This player holds no registered plots.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Plot</Th>
              <Th>Zoning</Th>
              <Th>World</Th>
              <Th>Role</Th>
              <Th>State</Th>
              <Th align="right">Price</Th>
              <Th>Lease ends</Th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => (
              <tr
                key={`${h.worldUuid}:${h.wgRegionId}:${h.role}`}
                className="hover:bg-surface-muted"
              >
                <Td mono>
                  <Link
                    href={`/regions/${h.worldUuid}/${encodeURIComponent(h.wgRegionId)}`}
                    className="text-accent hover:underline"
                  >
                    {h.wgRegionId}
                  </Link>
                </Td>
                <Td>
                  <span
                    className="text-xs text-muted"
                    title={categoryDefinition(h.category ?? "other").note}
                  >
                    {categoryDefinition(h.category ?? "other").label}
                  </span>
                </Td>
                <Td>{h.worldName ?? "—"}</Td>
                <Td>
                  <span className="text-xs text-muted">{h.role}</span>
                </Td>
                <Td>{h.state ?? "—"}</Td>
                <Td align="right">
                  <Money value={h.price} />
                </Td>
                <Td>
                  <RelativeTime value={h.leaseEndAt} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

async function Punishments({ uuid }: { uuid: string }) {
  const punishments = await getPlayerPunishments(uuid);
  if (punishments.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
        Punishment history ({punishments.length})
      </h2>
      <Table>
        <thead>
          <tr>
            <Th>Type</Th>
            <Th>Reason</Th>
            <Th>Started</Th>
            <Th>Ends</Th>
            <Th>Status</Th>
            <Th>Operator</Th>
          </tr>
        </thead>
        <tbody>
          {punishments.map((p) => {
            const active = p.isActive;
            return (
              <tr key={p.id} className="hover:bg-surface-muted">
                <Td>
                  <Badge tone={p.isDeportation ? "danger" : "neutral"}>
                    {p.isDeportation ? "deportation" : p.type.toLowerCase()}
                  </Badge>
                </Td>
                <Td>{p.reason}</Td>
                <Td>
                  <RelativeTime value={p.startAt} />
                </Td>
                <Td>
                  {p.isPermanent ? (
                    <span className="text-danger">never</span>
                  ) : (
                    <RelativeTime value={p.endAt} />
                  )}
                </Td>
                <Td>
                  {p.withdrawnAt ? (
                    <Badge tone="neutral" title="No longer present upstream">
                      withdrawn
                    </Badge>
                  ) : active ? (
                    <Badge tone="danger">active</Badge>
                  ) : (
                    <Badge tone="neutral">expired</Badge>
                  )}
                </Td>
                <Td>{p.operatorName ?? "—"}</Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </section>
  );
}
