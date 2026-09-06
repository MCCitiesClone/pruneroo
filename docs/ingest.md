# Ingest: probes, rate limits and the N+1s

Part of the [Pruneroo documentation](../README.md#documentation).

How the four upstream APIs are crawled, and why a quiet server costs a few
dozen requests an hour.

## Being a responsible API client

Three of the four upstream APIs publish no rate limits at all. This application
imposes its own, and treats staying under them as a correctness requirement.

**Nothing is re-crawled on a timer.** Every expensive crawl sits behind an O(1)
change probe, and only runs when the probe shows something actually moved.

The one timer-driven crawl is `treasury.prune.sweep`, and it is not a *re*-crawl:
it drains a finite backlog in which each player is asked about exactly once,
ever, and then falls idle. See [Prune](prune.md) for why no
probe can gate it.

The probe's observed value is committed as the watermark **only after the crawl
succeeds**, never when it is enqueued. Advancing it early would let an
interrupted crawl leave a silent, permanent gap — the next probe would compare
upstream against a figure we never actually ingested and conclude nothing had
changed. The watermark means "ingested up to here", not "saw this number".

Note also that `/stats/<type>` is a change *signal*, not a row target: it
disagrees with the paginated list by ~80 records for bans. Use it to detect
movement, never to assert completeness.

| Probe | Cost | Gates |
|---|---|---|
| `punishments.stats` | 4 requests | Crawls of bans, mutes, warns and kicks (~1,600 pages) |
| `realty.stats` | 1 request | A 79-page region re-index |
| `realty.activity` | a few | Per-region detail refreshes, only for regions the feed touched |

A quiet server therefore costs a few dozen requests per hour. Anything derived
from the passage of time — lease expiry, punishment expiry, the sliding 30-day
window — is computed locally from stored timestamps and never polled for.

**Self-imposed budgets** (`src/lib/http/budgets.ts`):

| Source | Rate | Concurrency | Basis |
|---|---|---|---|
| Realty | 60/min | 2 | undocumented upstream |
| Analytics | 30/min | 1 | undocumented; unpaginated whole-server payloads |
| Punishments | 60/min | 2 | undocumented |
| Treasury | per-endpoint, ×0.8 | 2 | documented quotas, scope-aware |

Treasury's quotas differ per endpoint and per token scope; the scope is read
once from `/auth/me` at boot. The 0.8 factor leaves headroom for the token
owner's own in-game usage. On top of that: `Retry-After` is honoured exactly,
`X-RateLimit-Remaining` slows the bucket before a 429 happens, failures back off
with jitter, and five consecutive failures open a per-source circuit breaker
whose state survives a restart.

Only one worker may run at a time, enforced by a Postgres advisory lock on a
dedicated connection. Two workers would each hold their own in-memory buckets
and between them double the upstream request rate.

## Avoiding the N+1s

Two upstream shapes would otherwise be very expensive:

**Realty ownership.** `/v1/regions` pages the whole region set but returns
identity only — ownership comes from `/v1/region`, one call per region (verified
against the live API, not just the spec). So the first run backfills all 7,837
regions once, and after that `/v1/activity?since=` drives refreshes for only the
regions that changed.

**30-day playtime.** `/v1/playersTable` returns the whole roster in one request
but only lifetime playtime. The 30-day figure needs `/v1/player?player=<uuid>`,
one call per player — and the roster is **92,970 players**, which at 30 req/min
would take 51 days. Three exact reductions shrink that set to something
tractable; none is an approximation:

1. Only **property stakeholders** are queried at all; they are the only players
   the insight concerns — 369 titleholders plus landlords and tenants, against a
   roster of ~93,000. This alone removes over 99% of the work.
2. **Last seen over 30 days ago ⇒ the 30-day figure is necessarily 0.** The bulk
   roster already told us `lastSeen`, so these players cost zero requests. They
   are reported as `inferred_zero`.
3. **Lifetime playtime unchanged since the last fetch ⇒ no new play occurred**,
   so the 30-day figure can only have decreased. No refetch needed.

Provenance is carried into the UI. A player whose playtime has never been
measured shows as `unmeasured` and is excluded from inactivity results, so the
headline count is never inflated by missing data.
