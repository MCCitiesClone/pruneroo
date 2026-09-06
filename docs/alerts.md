# Discord alerts

Part of the [Pruneroo documentation](../README.md#documentation).

Three independent webhooks, each switched on by setting its URL and inert when
unset:

| Channel | Fires when | Env |
|---|---|---|
| `notify.punishments` | A ban or deportation appears that we have not announced | `DISCORD_WEBHOOK_PUNISHMENTS` |
| `notify.prune` | A dormant player is priced above the alert floor | `DISCORD_WEBHOOK_PRUNE` |
| `notify.atRisk` | A property joins the at-risk list, **batched per holder** | `DISCORD_WEBHOOK_AT_RISK` |

They are queue jobs like any other, so they appear on `/sync`, retry with the
same backoff, and cannot overlap with themselves. They make **zero** upstream
crawl requests. Each is a local query over views the app already maintains plus
a POST to Discord, which is why they are allowed on a timer at all. The no-timer
rule is about re-reading someone else's API, and none of these does.

## Enabling a webhook is not an event

The first run of a newly configured channel records everything that already
qualifies **without sending it**, then alerts only on what arrives afterwards.
Seeding this database marks 2,858 punishments and 1,225 properties as already
known, and announcing those because someone pasted a webhook URL would bury the
one alert that mattered. The baseline is per channel, so adding a second webhook
later does not re-seed the first.

To deliberately replay a channel, delete its rows from
`notification_deliveries` and its `seeded.<channel>` row from `sync_watermarks`.

## Nothing is announced twice, and nothing is lost

`notification_deliveries` holds one row per channel and thing, written **after**
the message it belongs to is delivered. A run that fails halfway keeps what it
already sent and retries only the rest. Re-running a drained channel sends
nothing.

`DISCORD_MAX_ITEMS_PER_RUN` bounds a burst rather than discarding it, and the
remainder goes out on the next run. That matters most for prune, where the
balance backfill still has ~24k players to price and can qualify a lot of them
in an afternoon. The at-risk channel caps *holders* rather than plots, so one
player's properties are never split across two messages.

## The alerts cannot drift from the pages

Each channel queries the same views and predicates the UI does,
`v_active_punishments`, `v_prune_candidates` and `atRiskRowsCte`, rather than
restating the rules. `atRiskFlaggedSql` in particular is now shared by the
`/at-risk` table, the `/` headline counts and the notifier, because an alert
that disagrees with the page it links to looks exactly like a real change.

Two consequences worth knowing:

- **A lifted ban is not announced.** `v_active_punishments` does the login
  cross-check, so the "no revoked flag" trap in `AGENTS.md` does not leak into
  the alerts.
- **Excluded holders are skipped**, matching the pages' defaults. Today all six
  dormant players holding over $10,000 are on the exclusion list, so the prune
  channel is quiet for a good reason. The highest non-excluded dormant balance
  is $2,300.

## Checking a webhook without waiting for bad news

`/sync` carries a **Discord alerts** panel: one row per channel with its state,
how many things it has announced, and a **Send test** button. The test posts a
neutral-coloured, explicitly-labelled message and records *nothing*, so it
cannot consume a real alert or seed the channel.

The panel exists because a silent channel has three causes that look identical
from outside, and it names which one you have:

| Badge | Meaning |
|---|---|
| `not configured` | No webhook URL. Nothing will ever be sent. |
| `awaiting baseline` | Configured, but the seed pass has not run. The next run records history rather than announcing it. |
| `live` | Baseline recorded, and real alerts are flowing. |

Only the channel *name* crosses from the browser, and it is validated against
the roster before use. The server reads the webhook URL from the environment, so
the button cannot become a relay for posting to arbitrary hosts. The URLs never
appear in the rendered HTML.

## Alert floor vs list floor

`DISCORD_PRUNE_MIN_BALANCE`, default 10,000, is **not** `PRUNE_MIN_BALANCE`,
default 0. The page lists any credit at all, and alerting on every one of those
would be noise. SQL compares balances as `numeric` and formats them from their
exact decimal strings, since an alert stating a rounded balance would be worse
than no alert.

Discord itself goes through the shared throttle like every other host, at
`DISCORD_BUDGET` of 30 requests/minute, well under the documented 5 per 2
seconds per webhook. A 429 penalises that bucket using `retry_after`, which
Discord reports in **seconds**, often fractionally.
