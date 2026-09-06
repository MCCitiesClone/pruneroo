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

Three of the four upstream APIs publish no rate limits at all, so this
application imposes its own and treats staying under them as a correctness
requirement.

1. **Nothing is re-crawled on a timer.** Every expensive crawl sits behind an
   O(1) change probe, and anything time-derived — lease expiry, punishment
   expiry, the sliding 30-day window — is computed locally from stored
   timestamps rather than polled for.
2. **Every outbound request goes through one shared throttle**, keyed by host,
   and only one sync worker may run at a time (a Postgres advisory lock).
3. **Anything derivable locally is re-derived locally.** `npm run reparse`,
   `npm run reclassify` and the merge rebuild all cost zero upstream requests.

A quiet server therefore costs a few dozen requests an hour. The budgets, the
probes and the two N+1s that had to be reduced are in
[Ingest](docs/ingest.md).

## Documentation

| Page | What it covers |
|---|---|
| [Ingest: probes, rate limits and the N+1s](docs/ingest.md) | How each source is crawled, the self-imposed budgets, and the two N+1 shapes that would otherwise cost 51 days of requests. |
| [The at-risk list](docs/at-risk.md) | What flags a property, how the list is scoped, exclusions, zoning from tags, §17 plot limits and merged plots. |
| [The inspector report kit](docs/inspector-kit.md) | Assembling a forum report from a region page, which reason is detected, and linking the filed thread back. |
| [Prune: dormant players holding money](docs/prune.md) | The balance backfill that cannot be reduced, only paced — and how its progress is measured. |
| [Eviction reports (forum)](docs/eviction-reports.md) | The fifth source: why the HTML listing and not RSS, how titles are matched to plots, and `/reports`. |
| [Discord alerts](docs/alerts.md) | Three independent webhooks, why enabling one announces nothing, and why an alert cannot drift from its page. |
| [Where the live APIs differ from their specs](docs/upstream-apis.md) | The Punishments traps, deportations parsed out of free text, and how "active" is actually decided. |
| [Deployment](docs/deployment.md) | Running on a Pelican server: the egg, Postgres beside Wings, and moving an existing database across instead of re-crawling it. |

Also in `docs/`: `sources/` (the published OpenAPI specs), `probes/` (what the
live APIs actually returned, from `npm run probe`) and `policy/` (dated
snapshots of the Inspector Guide and Evictions Policy).

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
