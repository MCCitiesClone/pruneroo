# The at-risk list

Part of the [Pruneroo documentation](../README.md#documentation).

What puts a property on `/at-risk`, how the list is scoped, and the plot-limit
arithmetic behind the over-limit flag.

## Exclusions

Not every flagged holder needs action — staff accounts, government plots and
agreed exceptions recur on every pass. **Exclude** on an at-risk row (or on a
player page, where a reason can be attached) hides every property that player
holds. Exclusions are keyed on the player rather than the plot, since holders
usually own several.

Exclusions are operator state: no sync writes that table, so a decision made
once survives every re-crawl. [Realtor marks](#marking-a-realtor) work the same way. `/exclusions` lists them with how many flagged
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
  marks them ([below](#marking-a-realtor)). The bonus does not apply to black market, ranch or
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

Once a property is flagged, [the inspector report kit](inspector-kit.md)
assembles the forum report for it from the region page.
