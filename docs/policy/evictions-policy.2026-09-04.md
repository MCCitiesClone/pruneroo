# Evictions Policy — Department Policy

Source: <https://www.democracycraft.net/threads/evictions-policy.26813/>
Correct as of **September 4th, 2026**. Secretary Venne Montclair-Contour.

Supersedes `evictions-policy.2026-06-17.html` (Secretary winterwolf). That file
is kept as the archived previous version — the thread is edited in place, so the
old wording is not retrievable from the forum once it changes. The forum returns
403 to guests and to `npm run probe`, so this text was transcribed from a
logged-in view rather than fetched.

## What changed on 2026-09-04

Three substantive changes, all of which the app encodes:

1. **Plot-limit breaches split by tenure.** "Exceeding legal plot limits" was a
   single Plot Fairness line (3-day resolve). It is now
   *"Exceeding legal plot limits for **freehold** plots"* under Plot Fairness,
   while leasehold breaches move to **Rental Limitations** — a **0-day** report,
   i.e. the plot is evicted on the date filed. `insights/report-kit.ts` picks the
   report from the plot's `contract_type`.
2. **Rental Limitations gains two reasons:** the leasehold limit breach above,
   and *"Offering the right or ability to rent a government-owned leasehold plot
   for sale"*.
3. **Vaulting and compensation rewritten** — see below. The old 50%-of-sellback
   terms are gone entirely. Nothing in the app models compensation, so this is
   recorded here only.

Also: Plot Fairness dropped *"Renting beyond allowed amounts"* (absorbed by
Rental Limitations) and *"Town limits: see Oakridge & Aventura threads"*. The
town exemption itself is unaffected — it lives in PSA §17(10), not here. The
owner's resolution screenshot command changed from `/as me` to `/realty list`.

---

## Purpose

The Evictions Policy ensures that plots in Redmont remain active, well-developed,
and compliant with community standards. Property ownership is a privilege that
carries responsibility — including ongoing activity, appropriate development, and
respect for zoning rules.

This policy outlines the types of eviction reports, timelines for resolution, and
how players can respond or rectify issues. It also establishes clear expectations
to support fair plot distribution and maintain the visual and functional quality
of the server's towns and cities.

## Types of Reports

\* Time is approximate and depends on the evicting officer's time zone.

### Eyesore — 14 Days

Reasons:

- Basic geometric forms (e.g., cube/box, pyramid shapes) without architectural detailing.
- Minimal or absent use of windows or openings.
- Excessive exterior clutter on the property (e.g., disorganised block placement, random scattered builds).
- The use of basic or repetitive building materials in construction shall be limited. This includes:
  - The overuse of natural or raw blocks (e.g., dirt, cobblestone).
  - Excessive reliance on a single block type (e.g., constructing an entire structure primarily from quartz).
- Oversized, floating, or unsupported structure
- Clashing colours/materials
- Unrealistic or inappropriate interiors.
- Undeveloped exterior terrain. (i.e. large expanse of stone).
- Other objective visual concerns agreed on by Inspector

How to resolve:

- Update your build to address listed issues
- Open a DCT ticket if needed
- Post screenshots under the report to have it marked 'solved by owner'

### Lack of Progress — 7 Days

Reasons:

- No significant progress within 14 days of purchase
- Plot left empty for over 14 days

How to resolve:

- Continue building
- 'Significant progress' = 1 furnished floor or completed exterior shell
- Post progress screenshots to resolve the report

### Non-Compliance — 14 Days

Reasons:

- Incorrect zoning
- Zoning mismatch (e.g. Commercial on Residential).
- Theme non-compliance
- Above-ground farms on incorrect zones
- Altering historical builds
- Multiple beacons on residential plots
- No structure on the plot (i.e. where there is no lack of progress, but no structure)
- Specific plot rule violations (i.e. building a house outside of the residential envelope on a FR plot).
- Height violations (superstructure)
- Invalid commercial use/purpose
- Invalid agricultural use/purpose

How to resolve:

- Review and correct your build
- Open a DCT ticket if needed
- Post photos showing compliance to mark it 'solved by owner'

### Rental Limitations — 0 Days

Reasons:

- Breaking posted rental agreement
- Offering the right or ability to rent a government-owned leasehold plot for sale
- Exceeding legal plot limits for leasehold plots
- Unlawfully occupying New Player Plots
- Breaking other regulations related to rental plots

How to resolve:

- Plot will be evicted
- Open a DCT ticket for clarification

### Inactivity — 7 Days

Reasons:

- Less than 6 hours playtime in the past month
- Player banned or deported

How to resolve:

- Reach 6+ hours of playtime within 7 days
- If not possible, request a deferral only in exceptional circumstances.

### Plot Fairness — 3 Days

Reasons:

- Exceeding legal plot limits for freehold plots
- Holding restricted plots without meeting requirements

How to resolve:

- Reduce plot count to legal limits
- Post screenshot of `/realty list` under the report
- Inspector will evict least amount of plots necessary to resolve, with least
  disruption to the estate (i.e. empty plots, least loss first)

### Bridges — 3 Days

Reasons:

- Missing or expired permit
- Exceeding size limit (15W × ~12H)

How to resolve:

- Update or remove skybridge/groundbridge to comply
- Open a DCT ticket for permit or guidance

### Food Truck — 1 Day

Reasons:

- Missing required food truck/stand permit

How to resolve:

- Obtain valid permit
- Open a DCT ticket if unsure

## Common Eyesore Blocks and Combinations

The following blocks and block combinations are generally considered poor
practice when used as primary or unblended build materials. These are general
principles and have not regard for application in a deliberate, thematic, or
stylistically coherent manner.

**Windows & Detailing**

- Unstained glass windows (large plain glass panes without colour or framing)

**Blocks Overused in Superstructures**

- Glazed Terracotta (when used excessively or randomly).
- Cobblestone (when used as primary structural walls).
- Dirt, coarse dirt, or gravel (used as superstructure materials rather than landscaping).
- Wooden planks (when used as the sole or primary structural material for walls).
- Quartz (used in large builds without any secondary material or detailing).
- Sandstone (used in large builds without any secondary material or detailing).
- Concrete (used in large builds without any secondary material or detailing/texturing).

**Colour & Texture Clashes**

- Bright wool colours placed directly against each other (e.g., lime green + magenta).
- Multiple bright, clashing concrete colours in checkerboard or random patchwork patterns.
- Nether-themed blocks clashing with overworld palettes (e.g., netherrack + birch).
- Random ore blocks placed decoratively in floors or walls.

**Lighting Practices**

- Glowstone, sea lanterns, or frog lights spammed openly instead of integrated
  into fixtures or designs.

## Notification

When a report is filed, the Inspector will notify the player through in-game
mail. If your forum username matches your in-game name, you may also be pinged on
the forums.

Inspectors do not send notifications via Discord. It is your responsibility to
check your in-game mail regularly when logging in.

## Solving a Report

If you believe you have resolved the issues listed in the report, reply to the
report thread with screenshots showing the changes you've made.

Once confirmed, the Inspection Manager will mark the report as 'solved by owner,'
process payment to the Building Inspector, and archive the thread accordingly.

## Eviction Process

Department employees and staff may process an eviction at any time on or after
the eviction date, based on their own time zone. While this is usually done
within 24 hours, delays can occur — it is your responsibility to ensure
compliance before the deadline. If there is no response to the report, the
Inspector may escalate it to the Inspection Manager.

## Property Transfers with Active Eviction Notices

Eviction notices remain in effect with the transfer of properties to new owners.
It is the duty of the owner of the property at the time of the eviction notice to
disclose the pending eviction proceedings to prospective owners as required by
the Criminal Code Act, Duty of Disclosure. The new owner may reply to the thread
to resolve the report as appropriate.

## Vaulting and Compensation

When the eviction date passes without deferral:

- If it concerns a **leasehold** plot, the tenant will be evicted **without any
  reimbursement**.
- If it concerns a **freehold** plot and the eviction is due to **Eyesore**, the
  entire building will be vaulted. The plot will then be auctioned in the
  #realestate Discord channel, and the build can be retrieved later by submitting
  a staff /ticket.
- If it concerns a **freehold** plot and the eviction is for **any other reason**,
  the building will be auctioned in the #realestate Discord channel.

## Deferrals

If a player has an open report and needs additional time to resolve it, they may
request additional time by making a deferral request in specific circumstances.

## Commercial Purpose

A commercial purpose must be substantial, ongoing, and genuinely operational.
Token setups—like a few dusty chest shops selling sticks and cobblestone or
multiple chest shops selling the same item—do not qualify. Plots must demonstrate
active trade, rentals, or services that reflect real engagement, not just a
placeholder to dodge inactivity.

> If your shop sells more excuses than items, it's not a business.

A building will generally be considered to have a valid commercial purpose where:

- A significant proportion of the building's usable area is actively used for
  commercial activity relative to the building's overall size;
- Interior spaces are furnished or decorated in a manner consistent with their
  stated use;
- Multiple areas or units within the building are made available for use by
  others (e.g., offices, retail space, rentable areas, etc.); and
- The use of the building reflects a reasonable scale given its size (e.g., a
  skyscraper is not primarily occupied by storage or a handful of shops).

Commercial purpose can be satisfied by reasonably priced leasehold sub-regions.
Reasonable market rates are evidenced by rental activity reflecting prevailing
supply and demand within the relevant market.

## Agricultural Purpose

An agricultural purpose must be substantial, ongoing, and genuinely operational.
Minimal setups—like a few token crops, empty barns, or idle pens—do not meet this
standard. Farm plots are expected to show genuine activity through cultivation,
livestock management, or the production of agricultural goods.

> A 'farm' that yields more excuses than crops, it's not a farm.

A farmland (F or FR) plot will generally be considered to have a valid
agricultural purpose where:

- A substantial portion of the plot's surface and visible area is actively
  engaged in farming or livestock operations relative to the plot's overall size;
- The layout, furnishings, and landscaping of the plot reflect a practical
  agricultural use, such as crop fields, stables, greenhouses, or silos;
- Plots primarily used for decoration, storage, or hidden underground farms are
  not considered to meet the standard of an agricultural purpose - the
  discriminator is output of the plot's above-ground area.

Sub-category policy Owner: Secretary, Department of the Interior.
Managed by the DCT on behalf of the Department of the Interior.
Rangers may co-sponsor reports for this sub-category.
Secretary of the Interior is the appeal decision maker (quash/provide
feedback/uphold) for this sub-category.

## Completed Building

A finished plot is defined as a plot with a completed building which is compliant
with the building regulations and has a function, or a finished interior.

## Significant & Regular Progress

Significant & regular progress for a building is defined by completing at least 1
furnished floor or completing the shell of the building. Additionally, any work
made in the PBW with proof and intentions to be pasted is considered valid as
long as the progress is significant & meaningful.

## Conflict of Interest

No member of the Inspection Team or Department Leadership is to have involvement
in the eviction of another property where they have an interest in purchasing the
property. They are limited to reporting it as any other citizen is able to do,
but this must be done outside of Department channels.

## Subjectivity Notice

This policy is designed to ensure fairness, clarity, and consistency in the
administration of inspections and evictions. However, it is acknowledged that
certain determinations - particularly those relating to visual quality, aesthetic
judgment, or design cohesion - may involve an element of subjectivity.

Inspectors are expected to exercise professional judgment in applying these
standards, referencing this policy to ensure decisions are made objectively,
proportionately, and in good faith. Where a player believes that a decision has
been made unreasonably or inconsistently, they may request a review by the
Inspection Manager/Secretary of Construction and Transportation for final
consideration.
