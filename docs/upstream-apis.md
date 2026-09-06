# Where the live APIs differ from their specs

Part of the [Pruneroo documentation](../README.md#documentation).

`docs/sources/` holds the published OpenAPI specs and `docs/probes/` holds what
the live APIs actually returned. The Punishments service differs substantially,
so `src/lib/sources/punishments/` is written against observed behaviour.

| Spec says | Live API does |
|---|---|
| `id`, `type`, `scope` fields | none of them exist. Type comes from the endpoint, identity is a content hash |
| `victim`, `victimName` | `victimUuid`, `victimUsername` |
| Epoch **milliseconds** | epoch **seconds** |
| Permanent is `endTime: -1` | permanent is `end: 0` **or** `end: 9223372036854775`, Java `Long.MAX_VALUE` as seconds |
| Page overrun returns `404` | `200` with `{"morePages": false}` and no array |
| `page` / `totalPages` envelope | `morePages` boolean, page size 6 |
| No active/expired flag | an `active` field exists but is **always false** on every record sampled. `label` is the real status |
| Only `/ban` and `/mute` | `/punishments/warn/` (4,724) and `/punishments/kick/` (521) also exist, undocumented |
| Unknown type is an error | an unrecognised slug **returns the ban list without a word**. `/punishments/active/1` and `/punishments/nonsense/1` are byte-identical to `/punishments/ban/1` |
| `/stats/<type>` counts the list | it does **not**. `/stats/ban` reports 3,755 while `/punishments/ban/` serves 3,675 across 613 pages and then ends. Never treat the stats count as a completeness target |

The `label` field agrees with deriving status from `end` on all 2,542 mute
records, which is what validated the seconds-against-milliseconds reading.

Records also carry no stable identity, so the client synthesises one by hashing
type, victim, start and reason. Live ban page 276 contains two records that
collapse to the same hash, which Postgres rejects with *"ON CONFLICT DO UPDATE
command cannot affect row a second time"*. Every upsert batch is therefore
deduplicated by conflict key first, in `src/lib/db/dedupe.ts`.

## Deportations carry their lifecycle in free text

A deportation is not its own punishment type. It is an ordinary WARN or MUTE
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
forever: 74 of 821 flagged deportations were already finished.

`src/lib/sources/punishments/deportation.ts` parses this on ingest into real
`deportation_completed_at` and `deportation_expires_at` columns, and
`v_active_punishments` uses them instead of `end_at`. Free-text parsing lives in
tested application code rather than in SQL. The view only compares timestamps,
so a deportation lapses with the clock and needs no resync.

**After changing the parser, run `npm run reparse`, not a re-crawl.** The parsed
columns are a pure function of `reason`, which is already stored locally, so
re-deriving them costs zero upstream requests where a full re-crawl would cost
~1,900. Re-fetching data to recompute something you can derive locally is
exactly the load this project is built to avoid.

## A deportation only counts if it is long or indefinite

A player deported for three weeks comes back to their property. One deported
indefinitely does not. So `v_active_punishments` classifies every deportation as
**indefinite** with no expiry, **long** at four months or more, or **limited**,
and only the first two flag a property. Live: 657 indefinite, 44 long, 45
limited.

The classification reads `deportation_expires_at`, parsed out of the reason
text, because the upstream `end` is useless here. Every deportation reports
permanent, as the next section explains.

The second half matters as much as the first. **A limited deportation also
suppresses the inactivity ground.** A deported player cannot log in, so their
zero playtime is an artefact of the punishment rather than evidence about them.
Without this the rule would change nothing, because every deported holder reads
as inactive and gets flagged anyway. Ban and over-limit still flag as usual,
since the deportation causes neither.

The player page states which side a deportation falls on, so a holder missing
from the list is explained rather than mysterious.

## Revoked punishments, and how "active" is actually decided

The API has **no revoked or undone flag**, and a ban that staff lifted keeps
reporting `label: "Permanent"`, `end: 0`, `active: false` forever, identical to
one still in force. Taken at face value this made 606 of 2,718 "active" bans
wrong, 22% of them, including players who had logged in the same day.

`v_active_punishments` resolves it with a cross-source deduction. **A ban
prevents connecting, so if Analytics has seen the player since the ban began,
that ban is provably not being enforced.** It applies to `BAN` on purpose. A
mute does not stop a player logging in, so seeing them proves nothing about a
mute. `KICK` never counts as active at all, being an instant event rather than a
state.

Two gaps remain unsolvable upstream. A *permanent mute* that was revoked is
still indistinguishable from one in force, since the login check cannot speak to
mutes, and disappearance from a completed crawl, `withdrawn_at`, remains the
only other revocation signal. Both are worth raising with the API owner.

Separately, `victim` may hold an IP address rather than a UUID, which the
parser classifies apart so it never creates a phantom player.
