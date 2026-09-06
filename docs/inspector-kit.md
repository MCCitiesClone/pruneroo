# The inspector report kit

Part of the [Pruneroo documentation](../README.md#documentation).

Every region page carries a collapsible kit that assembles the forum report from
data already on screen: plot number, eviction date, owner, the guide's canned
resolution text, the criteria and evidence checklist for that reason, and the
commands `/dct-tp`, `/about`, `/rl list --player`, `/dct-eviction-notice add`
and `/dct-eviction-notice remove` with the owner and plot already filled in. The
eviction date is today plus the reason's resolve time: 0 days for Rental
Limitations, 3 for Plot Fairness, 7 for Inactivity and Lack of Progress, 14 for
Eyesore and Non-Compliance. Every field has a copy button.
[Merged plots](at-risk.md#merged-plots) produce a single kit covering all
sub-plots, titled `c176/c177 | Sep 11, 2026` to match the forum convention.

**The reason is detected where the data can decide it.** Three of the six can
be:

- **Inactivity.** The holder is banned, deported, or under the playtime minimum.
  The basis is spelled out, as in `Holder has 1.5h playtime in the past 30 days,
  under the 6h minimum`, and an *unmeasured* holder never triggers it, because
  never measured is not the same as zero.
- **Plot Fairness / Rental Limitations.** The holder is over a §17 limit **and
  this plot counts towards it**. A breach in a category this plot is exempt from
  is not grounds to file against this plot. If only an unconfirmed realtor
  allowance stands in the way, the basis says to check `/about` first.

  Which of the two it is comes from the plot's **tenure**, following the
  2026-09-04 policy. A freehold breach is Plot Fairness with 3 days to resolve,
  and the same breach on a leasehold is Rental Limitations, which evicts on the
  date filed. Anything not explicitly a leasehold files as Plot Fairness, so an
  unknown contract type errs towards giving the holder three days rather than
  evicting on sight.

  The *count* is not split by tenure. §17(5) and §17(7) cap what a player holds
  "owned or rented", so a freehold and a leasehold plot in one category still
  count against a single limit. One holder can be over one limit and owe a
  report of each kind on different plots.

Inactivity wins when any of them apply, because it covers the whole holding and
a banned holder cannot resolve a plot count. The limit report stays on the kit
as *also applies*. That holds even for Rental Limitations, despite it being the
harsher of the two: filing the report that evicts on sight should be a
deliberate choice, not a default.

The other three reasons are judgements about what a build looks like, and
nothing here has ever seen the plot, so the kit never guesses them. Picking one
fills in its eviction date, title, resolution text, criteria, evidence and
commands at once, because all five kits are built server-side, so switching is a
selection rather than a round trip. When nothing is detected the fields stay
hidden until a reason is chosen, rather than presenting a default that would
read as a recommendation.

## Linking the filed report back

The kit's last field is the one it cannot know. `/dct-eviction-notice add` takes
the report's URL, which does not exist until the thread is posted, so the kit
ends with a box to paste it into.

Pasting the link marks the plot as reported, which drops it off `/at-risk`,
pulls the thread in, and fills the URL into the command. Merged plots are linked
as a group, since §18(2) files them as one report.

This exists because the crawl runs the other way round. Finding reports by
walking the listings is right for the ~6,000 already filed and wrong for the one
filed thirty seconds ago. A change probe gates the listing sync and it runs on
its own schedule, so a fresh report is invisible until it catches up.

Linking suppresses a property from review, so the paste is verified rather than
trusted.

- The URL must be a **thread on this forum**. The origin comes from
  `FORUM_EVICTION_LISTING_URL` rather than being hardcoded. `/post-412216`,
  `/unread` and slugless variants all normalise to the canonical thread URL, and
  a bare thread id is accepted.
- The thread is **fetched and parsed**, one request through the same throttle as
  everything else rather than a crawl, so a 404 or a URL that resolves to a
  different thread is refused with a reason rather than stored.
- If the fetch cannot happen, because there is no cookie or an expired one, the
  link is still recorded, but the report row is marked `source = 'manual'` and
  shown as **provisional**. Its title is the URL slug and it carries no author
  or eviction date until a crawl confirms it. The listing upsert promotes it to
  `forum` and overwrites the placeholder title the moment it does.

A manual link is pinned with `source = 'manual'` on `eviction_report_regions`,
which the re-crawl never deletes, and the same panel can undo it. That is the
only way to reverse a link pasted onto the wrong plot, since a manually matched
report never appears in the unmatched list on `/reports`.

The reasons, resolve times, resolution wording and evidence lists come verbatim
from the Inspector Guide and Evictions Policy, archived under `docs/policy/`.
The policy thread is edited in place and returns 403 to guests, so each version
is kept dated. `evictions-policy.2026-09-04.md` is current and leads with what
changed, and `evictions-policy.2026-06-17.html` is the superseded snapshot the
app was originally written against.

The policy's **Vaulting and Compensation** terms were rewritten on 2026-09-04.
Leaseholds now evict with no reimbursement, and the old 50%-of-sellback terms
are gone. Nothing here models compensation, so that change is recorded in the
archived policy only.
