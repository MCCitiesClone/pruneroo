# Prune: dormant players holding money

Part of the [Pruneroo documentation](../README.md#documentation).

`/prune` lists players who have not logged in for 90 days and still hold a
positive balance, money that can be returned to the government. The thresholds
are `PRUNE_INACTIVITY_DAYS` and `PRUNE_MIN_BALANCE`, both tunable per request
from the page.

The inactivity half is free. The bulk roster already carries `lastSeen` for all
92,987 players, and dormancy is computed locally from that stored timestamp. No
polling, in keeping with the [no-timer rule](ingest.md).

**The balance half is the second big N+1, and unlike the playtime one it cannot
be reduced.** Treasury publishes no bulk balance endpoint, no baltop and no
list-accounts, so a balance costs one `/accounts/by-player` call plus one
`/accounts/{id}/balance` call, per player, and roughly 61,000 players are past
the threshold. None of the three reductions that shrank the playtime N+1 apply
here.

- The insight is about *any* dormant player with money, not just property
  stakeholders, so the population cannot be narrowed to the 1,515 stakeholders
  that `treasury.resolve.sweep` covers.
- Dormancy implies nothing about a balance. A player who stopped logging in
  years ago may still hold a fortune, and that is precisely who this page is
  for.
- There is no cheap change signal per account to gate on.

So the sweep paces the work instead of avoiding it. `treasury.prune.sweep`
prices a batch of `PRUNE_SWEEP_BATCH` players (default 150), longest-dormant
first, and falls to a trickle once drained as players cross the threshold.
`accountId` never changes, so each player is asked about exactly once, ever.

**The batch is worked in parallel, and that cannot raise the request rate.** A
pool of `PRUNE_SWEEP_CONCURRENCY` workers (default 4) processes the players, but
every call still goes through the shared throttle, which holds both the
per-endpoint token bucket and a 2-slot concurrency semaphore. At most two
treasury requests are ever in flight, whatever the pool width. That property is
what makes widening safe, so `tests/rate-limiter.test.ts` asserts it rather than
assuming it: 40 concurrent callers still yield a peak of 2, and parallel callers
still wait on the bucket.

The pool exists because the original sequential loop had the opposite problem.
Awaiting each player in turn, two calls of `by-player` then `balance`, meant one
request in flight against an allowance of 240/min, measured at 12-64 players a
minute depending on what else held the treasury slot. Raising
`PRUNE_SWEEP_BATCH` never helped. It only made each batch hold the slot longer.

Because throughput still varies with contention, nothing quotes a fixed
duration. `/prune` and `/sync` project from measured throughput instead, as
described below.

## Restarting does not restart the backfill

Progress commits per player, not per batch. Every player the sweep finishes
writes either a `treasury_accounts` row or a `treasury_account_misses` row, and
both exclude them from the candidate query, so the work already done is what
defines where the next pass starts. There is no cursor to lose and no batch to
roll back.

This is not a design intention that might drift. It is checked against a real
interruption. A run aborted mid-batch after 65 of 150 players, all 65 accounts
persisted, **0** of them came back as candidates, and no player has ever been
priced twice. The worst a restart costs is the single in-flight HTTP call.

The batch loops **inside one job** rather than fanning out one job per player,
which is the opposite of the choice made for the
[forum listing](eviction-reports.md#request-rate). The worker runs exactly one
job per source at a time. 61,000 queued jobs would each pay a claim/complete
round trip through `sync_jobs` on that single serial slot, and would block the
other treasury sweeps behind them for the whole backfill. A bounded batch
releases the slot roughly once a minute while the shared throttle paces the
requests inside it.

## A 404 is an answer, and has to be stored

`/accounts/by-player` returns 404 for anyone who never touched the economy, and
that fact lives nowhere else. Without recording it the sweep re-asks the same
unresolvable players on every pass and the backfill never converges past them.
The bug is invisible at stakeholder scale, where 5 of 1,515 miss, and fatal
across a roster full of one-session visitors. `treasury_account_misses` is that
negative cache, and entries age out after 90 days so an account opened later is
still found.

## Watching a job that takes a day

`treasury.prune.sweep` is the only job here measured in hours, and a run log
answers the wrong question. It shows the last batch, not how far through 61,000
players the whole thing is. Both `/prune` and `/sync` carry a **Balance
backfill** panel with a progress bar, the split of priced / no-account /
pending, a rate, an ETA, and whether a batch is running right now.

Two deliberate choices in what it measures:

- **Progress is derived state, not job bookkeeping.** Every player the sweep
  finishes writes either a `treasury_accounts` row or a
  `treasury_account_misses` row, so `pending` falls continuously *while* a batch
  runs rather than jumping when it commits.
- **The ETA divides by working time, not wall-clock.** Counting completions over
  the last half hour folds in every minute the worker was stopped. Measured
  overnight that gave 4.4 players/min against a working rate near 50, projecting
  nine days instead of one. The rate therefore comes from completed runs,
  `items_upserted` over run duration, which answers the question actually being
  asked: how long if it keeps running. Liveness is a separate figure,
  completions in the trailing window, since a healthy historical rate says
  nothing about whether anything is happening now.

Long runs also report in-flight. `RunHandle.progress()` updates the run row
every 10 players, so a working sweep looks different from a wedged one without
waiting for it to finish.

**The sweep cannot requeue itself, so the schedule closes the gap instead.**
`enqueue` is `onConflictDoNothing` and the dedupe index covers running rows, so
an enqueue issued from inside the sweep collides with the sweep's own live job
row and is dropped. That is a self-continuation which looks right, logs "next
batch queued", and does nothing. The tell was in the run log: batches started
*exactly* two minutes apart while each took ~70s, which is the one-minute
scheduler cadence with every other tick deduped.

So `treasury.prune.sweep` is scheduled every **15 seconds**, far shorter than a
batch. That is not a rate. Only one sweep is ever live, so a tick landing
mid-batch does nothing. What it bounds is how long the sweep sits idle *after*
one finishes. At the one-minute cadence that idle was 60.8s against 70s of work,
a **54% duty cycle** on a job with 55,000 players left.

Because of that cycling, the progress panel distinguishes **Cycling**, meaning a
batch finished seconds ago and another is imminent, from **Idle**, meaning
nothing has run and nothing is queued. A page loaded during a normal gap
otherwise reports "Idle", which reads as a stalled job when the sweep is working
fine.

`/sync` refreshes itself every 5 seconds via `router.refresh()`, which re-runs
the route's server components and patches the result in, so scroll position and
focus survive. It pauses while the tab is hidden and refreshes on return.
Polling is safe *there* because every query behind `/sync` is a local Postgres
read. The same treatment would be wrong on `/prune`, which issues a live
Treasury call per displayed row.

## The list is a lower bound until the backfill finishes

Provenance carries into the UI here for the same reason it does for playtime.
`balance_source` is one of `measured`, `no_account` or `pending`, and **a
pending player is excluded from the list rather than shown as broke**. The page
leads with the proportion actually priced, because "28 players are prunable"
read as a complete answer would hide however much is sitting in the 60,905
accounts not yet checked. Players who have no account count as *known*, since a
404 proves there is nothing to reclaim.

Balances of dormant players still move. Chest shops sell while the owner is
offline, and anyone can transfer money in. So `treasury.prune.balance.sweep`
re-reads them on a `PRUNE_BALANCE_MAX_AGE_HOURS` cycle, default 24h, and only
for accounts that hold something. That sweep is separate from
`treasury.balance.sweep`, which is scoped to stakeholders and holds them at
6-hour freshness. Merging the two would give the 300-per-pass cap 61,000
accounts to chase, and it would churn the oldest forever while starving the
accounts the at-risk list needs fresh.

## The page serves stored balances, not live reads

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
  first-served. Once the sweep ran in parallel and kept those slots busy, a page
  load went from ~5s to **82s**, long enough to read as broken. Serving from
  Postgres renders in **0.28s** and returns the whole upstream budget to the
  backfill.

The trade is that a balance can be up to a day old, so the page shows staleness
rather than implying freshness. Each row carries the timestamp of its last read,
and any row the refresh sweep has not reached inside
`PRUNE_BALANCE_MAX_AGE_HOURS` is badged **stale**. SQL computes that flag, not
`Date.now()` in a render body. The React Compiler rejects the latter outright,
and rightly, because it makes the component non-idempotent.

## What starved the backfill, twice

Two separate faults kept a 58,000-player job at a standstill. Both are worth
knowing because neither looks like a failure. The queue is healthy, no job
errors, and nothing progresses.

**An orphaned job blocks its own kind forever.** The dedupe index covers
`status IN ('pending', 'running')`, so a job left at `running` by a process that
died prevents any new job of that kind being enqueued. `reclaimStale` only frees
it after 15 minutes, checked every 5, so each restart cost the sweep up to 20
minutes. Observed once as `treasury.prune.sweep` held for 13 minutes by a dead
PID. `reclaimAbandoned()` now runs at worker startup, where it is
unconditionally safe: the exclusive advisory lock is already held, so anything
still marked `running` belongs to a process that is gone. It closes out the
abandoned run rows too, which otherwise claim to be running indefinitely and
make `/sync` and the backfill panel lie about whether anything is happening.

**One job per source let a shop crawl starve everything else.** That rule was
justified as "guaranteeing a source never runs two jobs at once against its own
quota", but the throttle enforces the quota, not job serialisation. So the rule
protected nothing while `treasury.chestshop.crawl`, at ~277 pages and 270s
average with a 427s worst case, held the only treasury lane. Treasury now runs
two jobs at once, `SOURCE_CONCURRENCY` in `worker.ts`, and both still contend
for the same two throttle slots, so the request rate is unchanged.

## The chest-shop crawl was removed

It has been deleted rather than tuned, because it was pure cost. **Nothing read
`chestshop_shops`.** No view, insight or page queried it, and the firm discovery
it was built to feed was never implemented, so `firms` never held a row. Of the
831 shop owners it found, 6 were not already in the analytics roster, which one
bulk call returns in full.

Against that it spent **6,313 of 15,155 treasury requests in 24 hours, 42% of
the budget**, and each crawl walked ~277 pages holding a serial job slot for
270s on average and 427s at worst. That is what starved the prune backfill.

Its change probe never gated anything either. The fingerprint included
`totalSales`, which moves on every sale, so on a busy server it reported
"changed" almost every time: 22 full crawls in 24 hours from a probe meant to
prevent exactly that.

Removed: the two handlers and their schedule entry, the client methods and Zod
schemas, the `chestshop` rate-limit group, the probe-script entry, and the table
itself in `drizzle/0015`, which also clears the dead watermark and any queued
jobs. If shop data is ever wanted again, the endpoints are still in
`docs/sources/treasury-api.json`.
