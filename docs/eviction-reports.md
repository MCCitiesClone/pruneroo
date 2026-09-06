# Eviction reports (forum)

Part of the [Pruneroo documentation](../README.md#documentation).

A fifth source: the forum's two eviction listings — the **open** forum and the
**archive**. Regions with an open report are already being dealt with, so they
drop out of the at-risk list. Archived reports are history: linked on the region
page as a previous report, never suppressing anything.

Both listings key on the same XenForo thread id, so a thread moving to the
archive is simply reclassified. That movement is the real resolution signal, and
the archive is processed after the open forum so being archived always wins.

## Why the HTML listing and not RSS

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

## When matching fails: `/reports`

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

## What the live listings contain

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

## Request rate

The forum is a website, not an API, and publishes no limits — so it gets the
gentlest budget here: **6 requests/minute, concurrency 1**. The 85-page backfill
is split into one queue job per page rather than an in-handler loop, so the
shared throttle genuinely paces it (~14 minutes), an interruption resumes from
the queue instead of restarting, and a failure retries one page rather than
re-crawling 83. Steady state is **8 requests/hour**: page 1 of each listing every
15 minutes, walking deeper only when a page's contents actually changed.

Suppressed plots are hidden, never dropped: the overview counts them and the
at-risk page has a **Show reported** toggle, the same pattern as [exclusions](at-risk.md#exclusions).

## The archive is walked once, then never again

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
