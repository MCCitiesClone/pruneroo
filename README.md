# Pruneroo

A unified insight dashboard over DemocracyCraft's four independent APIs.

Answering an operational question like *"which plots are held by players who have
gone inactive, been banned, or been deported?"* normally means cross-referencing
four systems that share no schema, no auth model, and no identity convention.
Pruneroo ingests all four into a local Postgres cache, reconciles them on
Minecraft UUID, and serves the answer as one query.

## Quick start

```sh
docker compose up -d db          # Postgres on :5434
cp .env.example .env             # then fill in credentials (see below)
npm install
npm run db:migrate               # migrations + insight views
npm run probe                    # sanity-check every upstream API
npm run dev                      # http://localhost:3000
```

`next dev` starts the background sync worker automatically. To run the worker
without the web server, use `npm run sync -- --worker`.

## Credentials

| Variable | Needed for | Notes |
|---|---|---|
| `ANALYTICS_USERNAME` / `ANALYTICS_PASSWORD` | 30-day playtime | **Required.** `/v1/whoami` reports `authRequired: true`; unauthenticated requests get an HTML login page, not JSON. |
| `TREASURY_TOKEN` | balances | Optional, but **required for `/prune`** — balances have no other source. Issue in-game with `/treasuryapi personal issue` or `/treasuryapi business issue`. A BUSINESS key gets 5× the rate quota, which matters here: the prune backfill is ~122,000 requests. |

Realty and Punishments are unauthenticated. Without the Analytics credentials
everything else still syncs; inactivity simply reports `unmeasured` for players
seen within the last 30 days.

## Being a responsible API client

Three of the four upstream APIs publish no rate limits at all. This application
imposes its own, and treats staying under them as a correctness requirement.

**Nothing is re-crawled on a timer.** Every expensive crawl sits behind an O(1)
change probe, and only runs when the probe shows something actually moved.

The one timer-driven crawl is `treasury.prune.sweep`, and it is not a *re*-crawl:
it drains a finite backlog in which each player is asked about exactly once,
ever, and then falls idle. See [Pruning](#pruning-dormant-players-holding-money)
for why no probe can gate it.

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

## Pruning: dormant players holding money

`/prune` lists players who have not logged in for 90 days and still hold a
positive balance — money that can be returned to the government. The thresholds
are `PRUNE_INACTIVITY_DAYS` and `PRUNE_MIN_BALANCE`, both tunable per request
from the page.

The inactivity half is free: the bulk roster already carries `lastSeen` for all
92,987 players, and dormancy is computed locally from that stored timestamp — no
polling, in keeping with the rule above.

**The balance half is the second big N+1, and unlike the playtime one it cannot
be reduced.** Treasury publishes no bulk balance endpoint — no baltop, no
list-accounts — so a balance costs one `/accounts/by-player` call plus one
`/accounts/{id}/balance` call, per player, and roughly 61,000 players are past
the threshold. None of the three reductions that shrank the playtime N+1 apply:

- The insight is about *any* dormant player with money, not just property
  stakeholders, so the population cannot be narrowed to the 1,515 stakeholders
  that `treasury.resolve.sweep` covers.
- Dormancy implies nothing about a balance. A player who stopped logging in
  years ago may still hold a fortune; that is precisely who this page is for.
- There is no cheap change signal per account to gate on.

So it is paced instead of avoided. `treasury.prune.sweep` prices a batch of
`PRUNE_SWEEP_BATCH` players (default 150), longest-dormant first, and falls to a
trickle once drained as players cross the threshold. `accountId` never changes,
so each player is asked about exactly once, ever.

**The batch is worked in parallel, and that cannot raise the request rate.**
Players are processed by a pool of `PRUNE_SWEEP_CONCURRENCY` (default 4), but
every call still goes through the shared throttle, which holds both the
per-endpoint token bucket and a 2-slot concurrency semaphore — so at most two
treasury requests are ever in flight, whatever the pool width. That property is
what makes widening safe, so it is asserted in `tests/rate-limiter.test.ts`
rather than assumed: 40 concurrent callers still yield a peak of 2, and parallel
callers still wait on the bucket.

The pool exists because the original sequential loop had the opposite problem.
Awaiting each player in turn — two calls, `by-player` then `balance` — meant one
request in flight against an allowance of 240/min, measured at 12-64 players a
minute depending on what else held the treasury slot. Raising `PRUNE_SWEEP_BATCH`
never helped; it only made each batch hold the slot longer.

Because throughput still varies with contention, nothing quotes a fixed
duration — `/prune` and `/sync` project from measured throughput instead
(below).

### Restarting does not restart the backfill

Progress is committed per player, not per batch. Every player the sweep finishes
writes either a `treasury_accounts` row or a `treasury_account_misses` row, and
both exclude them from the candidate query, so the work already done is what
defines where the next pass starts. There is no cursor to lose and no batch to
roll back.

This is not a design intention that might drift — it is checked against a real
interruption. A run aborted mid-batch after 65 of 150 players; all 65 accounts
persisted, **0** of them came back as candidates, and no player has ever been
priced twice. The worst a restart costs is the single in-flight HTTP call.

The batch loops **inside one job** rather than fanning out one job per player,
which is the opposite of the choice made for the forum listing. The worker runs
exactly one job per source at a time: 61,000 queued jobs would each pay a
claim/complete round trip through `sync_jobs` on that single serial slot, and
would block the other treasury sweeps behind them for the whole backfill. A bounded
batch releases the slot roughly once a minute while the shared throttle paces
the requests inside it.

### A 404 is an answer, and has to be stored

`/accounts/by-player` returns 404 for anyone who never touched the economy, and
that fact lives nowhere else. Without recording it the sweep re-asks the same
unresolvable players on every pass and the backfill never converges past them —
a bug that is invisible at stakeholder scale (5 of 1,515 miss) and fatal across
a roster full of one-session visitors. `treasury_account_misses` is that
negative cache; entries age out after 90 days so an account opened later is
still found.

### Watching a job that takes a day

`treasury.prune.sweep` is the only job here measured in hours, and a run log
answers the wrong question — it shows the last batch, not how far through 61,000
players the whole thing is. Both `/prune` and `/sync` carry a **Balance
backfill** panel with a progress bar, the split of priced / no-account /
pending, a rate, an ETA, and whether a batch is running right now.

Two deliberate choices in what it measures:

- **Progress is derived state, not job bookkeeping.** Every player the sweep
  finishes writes either a `treasury_accounts` row or a
  `treasury_account_misses` row, so `pending` falls continuously *while* a batch
  runs rather than jumping when it commits.
- **The ETA divides by working time, not wall-clock.** Counting completions over
  the last half hour folds in every minute the worker was stopped: measured
  overnight that gave 4.4 players/min against a working rate near 50, projecting
  nine days instead of one. The rate therefore comes from completed runs
  (`items_upserted` over run duration), which answers the question actually
  being asked — how long if it keeps running. Liveness is reported separately,
  as completions in the trailing window, since a healthy historical rate says
  nothing about whether anything is happening now.

Long runs also report in-flight: `RunHandle.progress()` updates the run row
every 10 players, so a working sweep is distinguishable from a wedged one
without waiting for it to finish.

**The sweep cannot requeue itself, so the schedule closes the gap instead.**
`enqueue` is `onConflictDoNothing` and the dedupe index covers running rows, so
an enqueue issued from inside the sweep collides with the sweep's own live job
row and is silently dropped — a self-continuation that looks right, logs "next
batch queued", and does nothing. The tell was in the run log: batches started
*exactly* two minutes apart while each took ~70s, which is the one-minute
scheduler cadence with every other tick deduped.

So `treasury.prune.sweep` is scheduled every **15 seconds**, far shorter than a
batch. That is not a rate — only one sweep is ever live, so a tick landing
mid-batch does nothing. It bounds how long the sweep sits idle *after* one
finishes. At the one-minute cadence that idle was 60.8s against 70s of work: a
**54% duty cycle** on a job with 55,000 players left.

Because of that cycling, the progress panel distinguishes **Cycling** (a batch
finished seconds ago, another is imminent) from **Idle** (nothing has run and
nothing is queued). A page loaded during a normal gap otherwise reports "Idle",
which reads as a stalled job when the sweep is working perfectly well.

`/sync` refreshes itself every 5 seconds via `router.refresh()`, which re-runs
the route's server components and patches the result in, so scroll position and
focus survive. It pauses while the tab is hidden and refreshes immediately on
return. Polling is safe *there* because every query behind `/sync` is a local
Postgres read; the same treatment would be wrong on `/prune`, which issues a
live Treasury call per displayed row.

### The list is a lower bound until the backfill finishes

Provenance is carried into the UI here for the same reason it is for playtime.
`balance_source` is one of `measured`, `no_account` or `pending`, and **a
pending player is excluded from the list rather than shown as broke**. The page
leads with the proportion actually priced, because "28 players are prunable"
read as a complete answer would hide however much is sitting in the 60,905
accounts not yet checked. Players who genuinely have no account count as
*known*: a 404 proves there is nothing to reclaim.

Balances of dormant players still move — chest shops sell while the owner is
offline, and anyone can transfer money in — so `treasury.prune.balance.sweep`
re-reads them on a `PRUNE_BALANCE_MAX_AGE_HOURS` cycle (default 24h), and only
for accounts that actually hold something. That sweep is separate from
`treasury.balance.sweep`, which is scoped to stakeholders and holds them at
6-hour freshness; merging the two would give the 300-per-pass cap 61,000
accounts to chase and it would churn the oldest forever while starving the
accounts the at-risk list needs fresh.

### The page serves stored balances, not live reads

`/prune` renders entirely from the local cache and makes **no upstream requests
at all**. Every figure comes from what the sweeps have stored.

It did briefly re-read each displayed balance from Treasury on load, so the
copyable command was guaranteed to match the account. Two things killed that:

- **A dormant player's balance barely moves.** That is the definition of the
  population, and `treasury.prune.balance.sweep` already re-reads dormant
  balances holding money on a 24-hour cycle, so the stored value is both stable
  and maintained.
- **It could not share a throttle with the backfill.** Page reads and sweep
  requests contend for the same two treasury concurrency slots, first-come
  first-served. Once the sweep was parallelised and kept those slots busy, a
  page load went from ~5s to **82s** — long enough to read as broken. Serving
  from Postgres renders in **0.28s** and returns the whole upstream budget to
  the backfill.

The trade is that a balance can be up to a day old, so staleness is shown rather
than implied: each row carries the timestamp of its last read, and any row the
refresh sweep has not reached inside `PRUNE_BALANCE_MAX_AGE_HOURS` is badged
**stale** on the row. That flag is computed in SQL, not from `Date.now()` in a
render body — the React Compiler rejects the latter outright, and rightly: it
makes the component non-idempotent.

### What starved the backfill, twice

Two separate faults kept a 58,000-player job at a standstill, both worth knowing
because neither looks like a failure — the queue is healthy, no job errors, and
nothing progresses.

**An orphaned job blocks its own kind forever.** The dedupe index covers
`status IN ('pending', 'running')`, so a job left at `running` by a process that
died prevents any new job of that kind being enqueued. `reclaimStale` only frees
it after 15 minutes, checked every 5, so each restart cost the sweep up to 20
minutes — observed as `treasury.prune.sweep` held for 13 minutes by a dead PID.
`reclaimAbandoned()` now runs at worker startup, where it is unconditionally
safe: the exclusive advisory lock is already held, so anything still marked
`running` belongs to a process that is gone. It closes out the abandoned run
rows too, which otherwise claim to be running indefinitely and make `/sync` and
the backfill panel lie about whether anything is happening.

**One job per source let a shop crawl starve everything else.** That rule was
justified as "guaranteeing a source never runs two jobs at once against its own
quota", but the quota is enforced by the throttle, not by job serialisation —
so it protected nothing while `treasury.chestshop.crawl` (~277 pages, 270s
average, 427s worst) held the only treasury lane. Treasury now runs two jobs at
once (`SOURCE_CONCURRENCY` in `worker.ts`); both still contend for the same two
throttle slots, so the request rate is unchanged.

### The chest-shop crawl was removed

It has been deleted rather than tuned, because it was pure cost. **Nothing read
`chestshop_shops`** — no view, insight or page queried it — and the firm
discovery it was built to feed was never implemented, so `firms` never held a
row. Of the 831 shop owners it found, 6 were not already in the analytics
roster, which one bulk call returns in full.

Against that it spent **6,313 of 15,155 treasury requests in 24 hours (42% of
the budget)**, and each crawl walked ~277 pages holding a serial job slot for
270s on average (427s at worst) — which is what starved the prune backfill.

Its change probe never gated anything either: the fingerprint included
`totalSales`, which moves on every sale, so on a busy server it reported
"changed" essentially every time — 22 full crawls in 24 hours from a probe meant
to prevent exactly that.

Removed: the two handlers and their schedule entry, the client methods and Zod
schemas, the `chestshop` rate-limit group, the probe-script entry, and the table
itself (`drizzle/0015`, which also clears the dead watermark and any queued
jobs). If shop data is ever wanted again, the endpoints are still in
`docs/sources/treasury-api.json`.

## Reviewing: exclusions and filters

Not every flagged holder needs action — staff accounts, government plots and
agreed exceptions recur on every pass. **Exclude** on an at-risk row (or on a
player page, where a reason can be attached) hides every property that player
holds. Exclusions are keyed on the player rather than the plot, since holders
usually own several.

Exclusions are operator state: no sync writes that table, so a decision made
once survives every re-crawl. Realtor marks (below) work the same way. `/exclusions` lists them with how many flagged
properties each is hiding and a one-click re-include, and the overview reports
the hidden count separately rather than folding it into the headline.

### Default scope

The at-risk list opens on **Reveille + the DCGovernment authority** — 123 rows
rather than 1,294 — because that is the slice actually worth reviewing. Both are
ordinary filters, shown and editable in the *Advanced — scope* panel;
`?world=all` and `?authority=all` are the explicit opt-outs. A blank field means
"any", not "revert to the default", or the field could never be cleared.

The at-risk table also filters by **authority** — a partial name or a full UUID.
Authority is the granting/oversight party on a freehold, a distinct concept from
the titleholder who owns the plot; in practice it is usually a government
account such as `DCGovernment`. It is matched independently of which stakeholder
raised the flag, so a plot flagged through its titleholder still appears when
you filter by the authority responsible for it.

Both controls apply to the CSV export as well. Page and export share one parser
(`src/lib/insights/filters.ts`) precisely so they cannot drift: they were
duplicated at first, and `Number(null) === 0` silently gave the export a 0-hour
threshold, dropping every inactive row from the download while the page still
showed them.

## Eviction reports (forum)

A fifth source: the forum's two eviction listings — the **open** forum and the
**archive**. Regions with an open report are already being dealt with, so they
drop out of the at-risk list. Archived reports are history: linked on the region
page as a previous report, never suppressing anything.

Both listings key on the same XenForo thread id, so a thread moving to the
archive is simply reclassified. That movement is the real resolution signal, and
the archive is processed after the open forum so being archived always wins.

### Why the HTML listing and not RSS

RSS looked like the obvious source and is unusable for this:

- **Hard capped at 100 items**, and it ignores every pagination parameter —
  `?page=2`, `/page-2/index.rss` and `_xfPage=2` all return the identical first
  page. With 2 pages of open reports and 83 of archive, RSS could see the newest
  ~1% of the archive and 100 of the 154 open reports.
- **It omits the thread prefix**, which is the status that says whether a report
  is still live.

The HTML listing paginates properly and carries the prefix. Parsing HTML is more
brittle than a feed, so `listing.ts` anchors on XenForo's structural class names
rather than layout, and a page that parses to zero threads is treated as an
error — failing loudly beats silently recording "no reports" and un-suppressing
every plot.

The forum node is **not guest-readable** — both its HTML and RSS return 403 —
so `FORUM_COOKIE` must hold an `xf_user` cookie from a logged-in browser.

**Matching is scoped to one world** (`FORUM_REGION_WORLD`, Reveille): plot names
in reports always refer to it, and without the scope a title can match a
same-named plot elsewhere — one report had already been mislinked to NewVault.

**Regions are matched against the ids we already hold, not by a regex.** Region
ids come in four unrelated shapes (`c176`, `1a`, `av-c031`, `432office-1`) and
are globally unique, so a title token either is a real region or it is not. One
report often names several plots — `c176/c177 | Sep 10, 2026` is two, and
`c390/c391/c392/c393` is four — and the shorthand `c176/177` also resolves by
borrowing the preceding prefix, which can only ever produce an id that exists.
Matching is **case-insensitive** — a report titled `C999` means plot `c999` —
while the id written to the database keeps its original casing, since 1,338 of
7,874 ids are mixed-case and the lowercased token joins back to nothing.

Three deliberate exceptions:

- **Bare integers never match.** Only two regions are named `1` and `3`, while
  titles are full of dates and counts.
- **Case-ambiguous names are refused, not guessed.** 33 pairs of Reveille plots
  differ *only* by case (`A1` vs `a1`, `C010-LobbyShop` vs `c010-lobbyshop`) and
  are genuinely different properties. Attaching a report to the wrong plot is
  worse than leaving it for a human, so those go to `/reports`.
- **Titles are read only from the `structItem-title` block.** A thread row also
  contains a `/threads/...` anchor in its start-date cell; a looser pattern
  matched *that*, storing 237 reports with a title of `<time class="u-dt" ...`
  that could never match a plot.

### When matching fails: `/reports`

Reports the parser could not resolve are listed at `/reports` under **Needs a
plot**, with counts for open, archived, unmatched and manually-linked. Each row
takes a plot id inline (case-insensitive, Reveille-scoped), and ambiguous input
is rejected naming both candidates rather than guessed.

Manual links are stored with `source = 'manual'` and **a sync never deletes
them** — only `parsed` links are re-derived on a crawl — so an assignment
survives every re-crawl.

**RSS is a window, not a list.** Reports that scroll out of the feed are left
untouched: unlike the punishments crawl, absence here carries no information, so
disappearance-based resolution would silently close open reports.

### What the live listings contain

Every report is titled `<regions> | <eviction date>`, and the listing carries a
status prefix. Observed on the open forum: `Pending`, `Auction Required`,
`Auctioning`, `Staff Action`, `Payment Required`, `Deadline Passed`, `Solved`.

Only `Solved` means finished — `Deadline Passed` is a call to act, not a
conclusion — so `EVICTION_RESOLVED_PREFIXES` defaults accordingly. `/sync` lists
every prefix actually observed, plus any report whose title named no known
region, so the vocabulary can be corrected without a code change.

Archival remains the stronger signal: a thread in the archive is finished
whatever its prefix says. The eviction date is parsed from the title too, and
shown on the region page.

### Request rate

The forum is a website, not an API, and publishes no limits — so it gets the
gentlest budget here: **6 requests/minute, concurrency 1**. The 85-page backfill
is split into one queue job per page rather than an in-handler loop, so the
shared throttle genuinely paces it (~14 minutes), an interruption resumes from
the queue instead of restarting, and a failure retries one page rather than
re-crawling 83. Steady state is **8 requests/hour**: page 1 of each listing every
15 minutes, walking deeper only when a page's contents actually changed.

Suppressed plots are hidden, never dropped: the overview counts them and the
at-risk page has a **Show reported** toggle, the same pattern as exclusions.

### The archive is walked once, then never again

The 85-page backfill runs exactly once per listing; a `backfill.<feed>`
watermark records that it finished. Afterwards **only page 1 is fetched**.
Threads are listed newest-first, so the first already-known thread on a page
means everything below it is known too — the crawl stops there rather than
paging on. A deeper page is requested only when page 1 turns out to be *entirely*
new, which is the one case where something could have scrolled past unseen.

An old report that names no plot we hold is not worth re-showing forever, so
`/reports` hides unmatched reports **older than 365 days** (`STALE_UNMATCHED` in
`insights/reports.ts`). That took the actionable unmatched list from 2,217 rows
to 20. The rows are filtered at query time, not deleted, so raising the cutoff
brings them straight back.

## Zoning, plot limits and merged plots

Inspectors evict for going over a plot limit as well as for inactivity, so the
app classifies every plot and counts holdings against the Property Standards
Act.

### Zoning comes from the tags, not the id prefix

Realty publishes tags per region, and they are the server's own classification.
Two things the `c176`-style prefix cannot express:

- **`wl-f*` plots are farmland.** Reading `wl` as its own zoning missed §17(7)'s
  limit of 1 on 113 plots — and once corrected, surfaced 4 genuine violations.
- **Area and zoning are orthogonal.** 90 Oakridge plots are tagged `commercial`;
  `or-` says only where a plot is, not what it is zoned for. They are separate
  columns (`regions.category`, `regions.area`) for exactly that reason.
- **Tags have to be read as a set, not one at a time.** A plot tagged both
  `farmland` and `residential` is a **ranch**, which §17(6) limits separately
  from farmland's §17(7). All 18 plots carrying that pair are `fr*` ids, so the
  prefix corroborates it; the 113 genuine farmland plots are tagged `farmland` +
  `willow`. Matching the first tag in a priority list called all 131 of them
  farmland and merged two limits of 1 into one.

The prefix survives only as a fallback for the handful of categories the tag
vocabulary has no word for — black market, CBD/NBD/WBD, ranch. It is
deliberately *not* used to guess zoning for the 5,354 untagged sub-regions
(`supermarket-1`, `apts-3`); those stay `other`, because inventing a zoning for
them would invent violations. `category_source` records which path was taken, so
a fallback is never mistaken for fact.

`npm run reclassify` re-derives every plot's zoning locally, making **zero**
upstream requests — tags are already stored.

### The exemptions are not uniform

| Area | Effect |
|---|---|
| Oakridge, Aventura | Towns. §17(10) exempts **every** plot inside them. |
| Willow | Not a town. Only **commercial** plots are exempt; Willow farmland still counts against the farmland limit of 1. |

That asymmetry is one function, `limitApplies(area, category)`, so the page,
the export and the `/limits` count cannot disagree about it.

### Limits are part of `/at-risk`, not a separate page

Being over a limit is a reason a property is at risk — a **Plot Fairness**
report on a freehold (3-day resolve) or **Rental Limitations** on a leasehold
(evicted on the date filed) — so it is a flag alongside inactive, banned and
deported rather than a second list to check. A flagged row shows `over limit 23/20`, and
the per-holder arithmetic behind those rows sits in a collapsed **Plot limits**
panel above the table. `/limits` redirects to `/at-risk?reason=over-limit`.

A plot is flagged only when it **counts** towards the breached limit: a holder
can be over the commercial limit while this particular plot of theirs is in
Oakridge and exempt, and that is not the plot to file against.

Two things are surfaced rather than hidden:

- **Exempt holdings are still displayed** — `Commercial 23/20 +2 exempt` — just
  never counted as a breach.
- **Realtor status is operator state.** §17(9) lets realtors exceed most limits
  by 5 and no API exposes the job, so a holder within `limit + 5` is reported as
  *check realtor status* until someone confirms it with `/about <player>` and
  marks them (below). The bonus does not apply to black market, ranch or
  Government Subsidised spaces, and the code encodes that per category.

Counting follows §18(1): merged plots count as their individual sub-plots.

The §17 decision table is **generated from the TypeScript rules** into the SQL
that the property table and the summary both run (`plots/limits-sql.ts`).
Writing the same limits a second time in `views.sql` is how a page and its own
summary drift apart.

Two counting rules that were wrong at first and are worth stating:

- **A limit is per category, summed across the map.** Counting each area
  separately reported `1/1` twice for a holder with one farmland plot in Willow
  and one outside, and missed the breach. §17(7) counts farmland "owned or
  rented", so a rented `wl-f*` plot counts against its tenant.
- **Exempt plots leave the count, they are not a separate bucket.** A town plot
  cannot be evicted for a limit breach, so it is subtracted from the total and
  reported next to it as context.

### Untagged sub-regions

A player page lists plots, not the sub-regions inside them. Two kinds are left
out: regions with **no tags at all** (billboards, yacht berths, shop units) and
regions tagged **only `apartment`** — 407 of them, each a unit inside someone
else's building. The tag has to be the only one; `apartment, shop` and
`apartment, commercial` are real plots and stay.

It matters at scale: `Technofied` holds 329 regions, of which 131 are untagged
and 178 are apartment units — the page shows the 20 actual plots and reports
`309 sub-regions hidden` in the heading rather than dropping them quietly. Since
none of these carries zoning, hiding them cannot change a plot-limit count.

### Marking a realtor

The realtor job is not in any API, so `/players/[uuid]` has a **Mark realtor**
control with an optional note on how it was confirmed. It is operator state,
like exclusions: no sync ever writes `player_realtors`, so the decision survives
every re-crawl.

Marking changes what counts as a violation. `ISweatDuels` holds 23 commercial
plots against a limit of 20: unmarked they are 23 rows flagged *check realtor
status*; marked, §17(9) raises the ceiling to 25 and all 23 rows drop out of the
list. Unmark and they come back. The player page also shows that holder's
category counts, since that page is where the question gets answered.

### Merged plots

Multiple plots named in one eviction report are a merged property. Two rules are
enforced before that is believed, because a report title is not proof:

1. **Same owner.** Different titleholders cannot be merged, whatever the report
   says. This rejected 324 candidate groups — whose members averaged 618 days
   between purchases, against 226 for accepted merges.
2. **Geographically contiguous.** Sub-plot bounds must form a connected graph at
   a gap of ≤2 blocks (`ADJACENCY_BLOCKS`). Connectivity, not all-pairs: four
   merged plots in a row are a merge even though the two ends do not touch. The
   threshold comes from the data — 660 candidate pairs sit 0–2 blocks apart and
   then there is a cliff.

Rejections are stored with their reason rather than dropped, so a bad merge is
visible instead of silently absent. The rebuild job makes **zero** upstream
requests; owner and bounds are already cached.

Result: 240 merged groups covering 634 plots. Merged plots show as
`merged ×N` on the at-risk table and get a card on the region page explaining
that they count individually for limits (§18(1)) but are filed as **one**
eviction report (§18(2)).

### Inspector report kit

Every region page carries a collapsible kit that assembles the forum report from
data already on screen: plot number, eviction date (today plus the reason's
resolve time — 0 days for Rental Limitations, 3 for Plot Fairness, 7 for
Inactivity and Lack of Progress, 14 for Eyesore and Non-Compliance), owner, the
guide's canned resolution text,
the criteria and evidence checklist for that reason, and the commands
(`/dct-tp`, `/about`, `/rl list --player`, `/dct-eviction-notice add`,
`/dct-eviction-notice remove`) with the owner and plot already filled in. Every field
has a copy button. Merged plots produce a single kit covering all sub-plots,
titled `c176/c177 | Sep 11, 2026` to match the forum convention.

**The reason is detected where the data can decide it.** Three of the six can be:

- **Inactivity** — the holder is banned, deported, or under the playtime
  minimum. The basis is spelled out (`Holder has 1.5h playtime in the past 30
  days, under the 6h minimum`), and an *unmeasured* holder never triggers it,
  because never measured is not the same as zero.
- **Plot Fairness / Rental Limitations** — the holder is over a §17 limit **and
  this plot counts towards it**; a breach in a category this plot is exempt from
  is not grounds to file against this plot. If only an unconfirmed realtor
  allowance stands in the way, the basis says to check `/about` first.

  Which of the two it is comes from the plot's **tenure**, following the
  2026-09-04 policy: a freehold breach is Plot Fairness with 3 days to resolve,
  the same breach on a leasehold is Rental Limitations and evicts on the date
  filed. Anything not explicitly a leasehold files as Plot Fairness, so an
  unknown contract type errs towards giving the holder three days rather than
  evicting on sight.

  The *count* is not split by tenure. §17(5) and §17(7) cap what a player holds
  "owned or rented", so a freehold and a leasehold plot in one category still
  count against a single limit — one holder can be over one limit and owe a
  report of each kind on different plots.

Inactivity wins when any of them apply — it covers the whole holding, and a
banned holder cannot resolve a plot count — with the limit report kept as *also
applies*. That holds even for Rental Limitations, despite it being the harsher
of the two: filing the report that evicts on sight should be a deliberate
choice, not a default.

The other three reasons are judgements about what a build looks like, and
nothing here has ever seen the plot, so they are never guessed. Picking one
fills in its eviction date, title, resolution text, criteria, evidence and
commands immediately; all five kits are built server-side, so switching is a
selection rather than a round trip. When nothing is detected the fields stay
hidden until a reason is chosen, rather than presenting a default that would
read as a recommendation.

### Linking the filed report back

The kit's last field is the one it cannot know: `/dct-eviction-notice add` takes
the report's URL, which does not exist until the thread is posted. So the kit
ends with a box to paste it into.

Pasting the link marks the plot as reported — which drops it off `/at-risk` —
pulls the thread in, and fills the URL into the command. Merged plots are linked
as a group, since §18(2) files them as one report.

This exists because the crawl runs the other way round. Finding reports by
walking the listings is right for the ~6,000 already filed and wrong for the one
filed thirty seconds ago: the listing sync is gated behind a change probe and
runs on its own schedule, so a fresh report is invisible until it catches up.

Linking suppresses a property from review, so the paste is verified rather than
trusted:

- The URL must be a **thread on this forum** — the origin is taken from
  `FORUM_EVICTION_LISTING_URL`, not hardcoded. `/post-412216`, `/unread` and
  slugless variants all normalise to the canonical thread URL, and a bare thread
  id is accepted.
- The thread is **fetched and parsed** (through the same throttle as everything
  else — one request, not a crawl), so a 404 or a URL that resolves to a
  different thread is refused with a reason rather than stored.
- If the fetch cannot happen — no cookie, or an expired one — the link is still
  recorded, but the report row is marked `source = 'manual'` and shown as
  **provisional**: its title is the URL slug and it carries no author or eviction
  date until a crawl confirms it. The listing upsert promotes it to `forum` and
  overwrites the placeholder title the moment it does.

A manual link is pinned with `source = 'manual'` on `eviction_report_regions`,
which the re-crawl never deletes, and can be undone from the same panel — the
only way to reverse a link pasted onto the wrong plot, since a manually matched
report never appears in the unmatched list on `/reports`.

The reasons, resolve times, resolution wording and evidence lists are taken
verbatim from the Inspector Guide and Evictions Policy, archived under
`docs/policy/`. The policy thread is edited in place and returns 403 to guests,
so each version is kept dated — `evictions-policy.2026-09-04.md` is current and
leads with what changed; `evictions-policy.2026-06-17.html` is the superseded
snapshot the app was originally written against.

The policy's **Vaulting and Compensation** terms were rewritten on 2026-09-04
(leaseholds now evict with no reimbursement, and the old 50%-of-sellback terms
are gone). Nothing here models compensation, so that change is recorded in the
archived policy only.

## Discord alerts

Three independent webhooks, each switched on by setting its URL and silently
inert when unset:

| Channel | Fires when | Env |
|---|---|---|
| `notify.punishments` | A ban or deportation appears that we have not announced | `DISCORD_WEBHOOK_PUNISHMENTS` |
| `notify.prune` | A dormant player is priced above the alert floor | `DISCORD_WEBHOOK_PRUNE` |
| `notify.atRisk` | A property joins the at-risk list, **batched per holder** | `DISCORD_WEBHOOK_AT_RISK` |

They are queue jobs like any other, so they appear on `/sync`, retry with the
same backoff, and cannot overlap with themselves. They make **zero** upstream
crawl requests — each is a local query over views the app already maintains plus
a POST to Discord — which is why they are allowed on a timer at all: the
no-timer rule is about re-reading someone else's API, and none of these does.

### Enabling a webhook is not an event

The first run of a newly configured channel records everything that already
qualifies **without sending it**, then alerts only on what arrives afterwards.
Seeding this database marks 2,858 punishments and 1,225 properties as already
known; announcing those because someone pasted a webhook URL would bury the one
alert that mattered. The baseline is per channel, so adding a second webhook
later does not re-seed the first.

To deliberately replay a channel, delete its rows from
`notification_deliveries` and its `seeded.<channel>` row from `sync_watermarks`.

### Nothing is announced twice, and nothing is lost

`notification_deliveries` holds one row per (channel, thing), written **after**
the message it belongs to is delivered. A run that fails halfway keeps what it
already sent and retries only the rest. Re-running a drained channel sends
nothing.

`DISCORD_MAX_ITEMS_PER_RUN` bounds a burst rather than discarding it — the
remainder goes out on the next run. That matters most for prune, where the
balance backfill still has ~24k players to price and can qualify a lot of them
in an afternoon. The at-risk channel caps *holders* rather than plots, so one
player's properties are never split across two messages.

### The alerts cannot drift from the pages

Each channel queries the same views and predicates the UI does —
`v_active_punishments`, `v_prune_candidates`, `atRiskRowsCte` — rather than
restating the rules. `atRiskFlaggedSql` in particular is now shared by the
`/at-risk` table, the `/` headline counts and the notifier, because an alert
that disagrees with the page it links to is indistinguishable from a real
change.

Two consequences worth knowing:

- **A lifted ban is not announced.** `v_active_punishments` does the login
  cross-check, so the "no revoked flag" trap in `AGENTS.md` does not leak into
  the alerts.
- **Excluded holders are skipped**, matching the pages' defaults. Today all six
  dormant players holding over $10,000 are on the exclusion list, so the prune
  channel is legitimately quiet — the highest non-excluded dormant balance is
  $2,300.

### Checking a webhook without waiting for bad news

`/sync` carries a **Discord alerts** panel: one row per channel with its state,
how many things it has announced, and a **Send test** button. The test posts a
neutral-coloured, explicitly-labelled message and records *nothing* — it cannot
consume a real alert or seed the channel.

The panel exists because a silent channel has three causes that look identical
from outside, and it names which one you have:

| Badge | Meaning |
|---|---|
| `not configured` | No webhook URL. Nothing will ever be sent. |
| `awaiting baseline` | Configured, but the seed pass has not run. The next run records history rather than announcing it. |
| `live` | Baseline recorded; real alerts are flowing. |

Only the channel *name* crosses from the browser, and it is validated against
the roster before use — the webhook URL is read from the environment server-side,
so the button cannot be turned into a relay for posting to arbitrary hosts. The
URLs never appear in the rendered HTML.

### Alert floor vs list floor

`DISCORD_PRUNE_MIN_BALANCE` (default 10,000) is **not** `PRUNE_MIN_BALANCE`
(default 0). The page lists any credit at all; alerting on every one of those
would be noise. Balances are compared in SQL as `numeric` and formatted from
their exact decimal strings — an alert stating a rounded balance would be worse
than no alert.

Discord itself goes through the shared throttle like every other host
(`DISCORD_BUDGET`, 30 requests/minute, well under the documented 5-per-2-seconds
per webhook), and a 429 penalises that bucket using `retry_after` — which
Discord reports in **seconds**, often fractionally.

## Where the live APIs differ from their specs

`docs/sources/` holds the published OpenAPI specs; `docs/probes/` holds what the
live APIs actually returned. The Punishments service differs substantially, and
`src/lib/sources/punishments/` is written against observed behaviour:

| Spec says | Live API does |
|---|---|
| `id`, `type`, `scope` fields | none of them exist; type comes from the endpoint, identity is a content hash |
| `victim`, `victimName` | `victimUuid`, `victimUsername` |
| Epoch **milliseconds** | epoch **seconds** |
| Permanent = `endTime: -1` | permanent = `end: 0` **or** `end: 9223372036854775` (Java `Long.MAX_VALUE` as seconds) |
| Page overrun → `404` | `200` with `{"morePages": false}` and no array |
| `page` / `totalPages` envelope | `morePages` boolean, page size 6 |
| No active/expired flag | an `active` field exists but is **always false** on every record sampled; `label` is the real status |
| Only `/ban` and `/mute` | `/punishments/warn/` (4,724) and `/punishments/kick/` (521) also exist, undocumented |
| Unknown type → error | an unrecognised slug **silently returns the ban list** — `/punishments/active/1` and `/punishments/nonsense/1` are byte-identical to `/punishments/ban/1` |
| `/stats/<type>` counts the list | it does **not**: `/stats/ban` reports 3,755 while `/punishments/ban/` serves 3,675 across 613 pages and then ends. Never treat the stats count as a completeness target |

The `label` field agrees with deriving status from `end` on all 2,542 mute
records, which is what validated the seconds-vs-milliseconds reading.

Records also carry no stable identity, so one is synthesised by hashing
(type, victim, start, reason). Live ban page 276 contains two records that
collapse to the same hash, which Postgres rejects with *"ON CONFLICT DO UPDATE
command cannot affect row a second time"* — every upsert batch is therefore
deduplicated by conflict key first (`src/lib/db/dedupe.ts`).

### Deportations carry their lifecycle in free text

A deportation is not its own punishment type — it is an ordinary WARN or MUTE
whose `reason` encodes the real state, and the underlying punishment is usually
INFINITE. So `end_at` says nothing about whether someone is still deported:

```
Deportation: <rule> (Expiry: None)
Deportation: <rule> (Expiry: 2026-08-28 11:14:07)
Deportation: <rule> Expiry: 07/10/2023                        (legacy form)
Deportation: <rule> (Expiry: None) - Completed 2025-11-10 12:34:51
```

`- Completed <timestamp>` means the player served it and is no longer deported,
even though the WARN never expires. Reading only `end_at` flagged those players
forever — 74 of 821 flagged deportations were already finished.

`src/lib/sources/punishments/deportation.ts` parses this on ingest into real
`deportation_completed_at` / `deportation_expires_at` columns, and
`v_active_punishments` uses them instead of `end_at`. Free-text parsing lives in
tested application code rather than in SQL; the view only compares timestamps,
so a deportation lapses with the clock and needs no resync.

**After changing the parser, run `npm run reparse`, not a re-crawl.** The parsed
columns are a pure function of `reason`, which is already stored locally, so
re-deriving them costs zero upstream requests — where a full re-crawl would cost
~1,900. Re-fetching data to recompute something you can derive locally is
exactly the load this project is built to avoid.

### A deportation only counts if it is long or indefinite

A player deported for three weeks comes back to their property; one deported
indefinitely does not. So `v_active_punishments` classifies every deportation as
**indefinite** (no expiry), **long** (four months or more) or **limited**, and
only the first two flag a property. Live: 657 indefinite, 44 long, 45 limited.

The classification reads `deportation_expires_at`, parsed out of the reason
text, because the upstream `end` is useless here — every deportation reports
permanent (see below).

The second half matters as much as the first: **a limited deportation also
suppresses the inactivity ground**. A deported player cannot log in, so their
zero playtime is an artefact of the punishment rather than evidence about them,
and without this the rule would change nothing — every deported holder reads as
inactive and gets flagged anyway. Ban and over-limit still flag normally, since
neither is caused by the deportation.

The player page states which side a deportation falls on, so a holder missing
from the list is explained rather than mysterious.

### Revoked punishments, and how "active" is actually decided

The API has **no revoked/undone flag**, and a ban that staff lifted keeps
reporting `label: "Permanent"`, `end: 0`, `active: false` forever — identical to
one still in force. Taken at face value this made 606 of 2,718 "active" bans
(22%) wrong, including players who had logged in the same day.

`v_active_punishments` resolves it with a cross-source deduction: **a ban
prevents connecting, so if Analytics has seen the player since the ban began,
that ban is provably not being enforced.** It is limited to `BAN` on purpose — a
mute does not stop a player logging in, so seeing them proves nothing about a
mute. `KICK` never counts as active at all, being an instant event rather than a
state.

Two gaps remain genuinely unsolvable upstream: a *permanent mute* that was
revoked is still indistinguishable from one in force (the login check cannot
speak to mutes), and disappearance from a completed crawl (`withdrawn_at`)
remains the only other revocation signal. Worth raising with the API owner.

Separately, `victim` may hold an IP address rather than a UUID, which is
classified apart so it never creates a phantom player.

## Deployment

Runs as a single Pelican (or Pterodactyl) server: one container running
`next start` with the sync worker inside the same process. `deploy/` holds the
egg, the startup script, a Compose file for the Postgres it needs beside Wings,
a Caddy example, and the dump/restore pair that moves an existing database into
production rather than re-crawling it — the balance backfill alone is ~122,000
upstream requests.

```sh
./deploy/scripts/dump-dev-db.sh                # dev database -> portable dump
./deploy/scripts/restore-prod-db.sh dump.file  # on the node; drops and recreates
```

Full runbook, including the ways panel variables differ from a `.env` file:
[`docs/deployment.md`](docs/deployment.md).

## Commands

```sh
npm run dev                                    # app + sync worker
npm run sync -- --list                         # all job kinds
npm run sync -- --kind=punishments.stats       # run one job once
npm run sync -- --worker                       # worker only, foreground
npm run probe                                  # capture live API payloads
npm run reparse                                # re-derive parsed columns locally, no API calls
npm run reclassify                             # re-derive plot zoning from tags, no API calls
npm run sync -- --kind=plots.merges.rebuild    # rebuild merged-plot groups, no API calls
npm run db:generate                            # new migration from schema.ts
npm run db:migrate                             # apply migrations + views
npm test                                       # unit tests
```

## Layout

```
src/lib/http/        rate limiter, retrying client, circuit breaker
src/lib/sources/     one typed client per API, with runtime validation
src/lib/sync/        durable job queue, scheduler, per-source worker
src/lib/db/          Drizzle schema + insight views (views.sql)
src/lib/plots/       zoning + limits (categories.ts), merge validation (merge.ts)
src/lib/insights/    queries backing the dashboard
src/app/             overview, at-risk (properties + plot limits), prune,
                     reports, exclusions, players, regions, sync health
```

Zod validation is not optional on the way in: the Analytics endpoints are
declared as untyped `{}` in their spec, so runtime validation is the only
contract available. Money from Treasury is kept as a decimal string end to end
and stored as Postgres `numeric` — it never passes through a JS number.

## Notes on the stack

Next.js 16.3 with the App Router. `cacheComponents` is deliberately **off**:
reads hit local Postgres in single-digit milliseconds and must be fresh, so
Next's cache layer adds nothing, and enabling it would forbid reading
`searchParams` inside cached scopes — a direct conflict with the filterable
at-risk table. The cache in this system is Postgres.

The sync worker is started from `instrumentation.ts`, the only startup hook Next
documents. It documents no cron convention, so hosting a scheduler there is a
deliberate choice — valid because this deploys as a single long-running
self-hosted process, and guarded by the advisory lock regardless.
