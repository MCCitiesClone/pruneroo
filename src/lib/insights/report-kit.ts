/**
 * Everything an inspector needs to file an eviction report, assembled from data
 * already on screen.
 *
 * Modelled directly on the Inspector Guide's filing steps: plot number,
 * eviction date, plot owner (from `/as info region` — the guide is explicit
 * that this is *not* the landlord), a report reason, the resolution text, and
 * the evidence that reason requires. The resolve times come from the Evictions
 * Policy.
 *
 * The point is to remove transcription: an inspector reading a flagged plot
 * here should be able to copy each field straight into the forum form rather
 * than re-deriving dates and re-typing usernames.
 */

export type ReportReason =
  | "inactivity"
  | "plot-fairness"
  | "rental-limitations"
  | "lack-of-progress"
  | "eyesore"
  | "non-compliance";

export interface ReasonDefinition {
  reason: ReportReason;
  label: string;
  /** Days added to today to get the eviction date (Evictions Policy). */
  resolveDays: number;
  /** Criteria, quoted from the Evictions Policy. */
  criteria: string[];
  /** The guide's pre-written "how to resolve" text, given to the owner. */
  resolution: string;
  /** Evidence the guide requires for this reason. */
  evidence: string[];
}

export const REASONS: Record<ReportReason, ReasonDefinition> = {
  inactivity: {
    reason: "inactivity",
    label: "Inactivity",
    resolveDays: 7,
    criteria: [
      "Less than 6 hours playtime in the past month",
      "Player banned or deported",
    ],
    resolution:
      "You have seven days to meet the minimum 6-hour playtime requirement. " +
      "If you're unable to meet this due to valid reasons, you may request a " +
      "deferral via the deferral request.",
    evidence: [
      "Screenshot of /about showing under 6 hours playtime in past month",
      "Screenshot of permanent ban via /hist <playername>",
      "Proof of ownership: screenshot of /rl info region or the player's /rl list --player",
    ],
  },
  "plot-fairness": {
    reason: "plot-fairness",
    label: "Plot Fairness",
    resolveDays: 3,
    criteria: [
      // "Renting beyond allowed amounts" moved to Rental Limitations in the
      // 2026-09-04 policy, and the town-limits line was dropped — towns are
      // still exempt under PSA §17(10), which is where that rule actually lives.
      "Exceeding legal plot limits for freehold plots",
      "Holding restricted plots without meeting requirements",
    ],
    resolution:
      "Reduce your plot holdings to comply with legal limits. Post a " +
      'screenshot of your /realty list menu in the report thread to resolve ' +
      'the report as "solved by owner."',
    evidence: [
      "Proof of owning more plots than allowed",
      "Screenshot of /about <playername> to confirm realtor job status",
      "Proof of ownership: screenshot of /rl info region or the player's /rl list --player",
    ],
  },
  /**
   * The leasehold half of a plot-limit breach, split out by the 2026-09-04
   * policy. Note the resolve time: **zero days**. The policy's "Plot will be
   * evicted" is not a deadline the tenant can work towards, so the eviction
   * date this produces is the day the report is filed.
   */
  "rental-limitations": {
    reason: "rental-limitations",
    label: "Rental Limitations",
    resolveDays: 0,
    criteria: [
      "Exceeding legal plot limits for leasehold plots",
      "Breaking posted rental agreement",
      "Offering the right or ability to rent a government-owned leasehold plot for sale",
      "Unlawfully occupying New Player Plots",
      "Breaking other regulations related to rental plots",
    ],
    resolution:
      "Immediate eviction applies if rental rules were broken. For further " +
      "clarification or dispute, open a DCT ticket.",
    evidence: [
      "Screenshot of posted landlord rules being violated",
      "For a limit breach: proof of holding more leasehold plots than allowed",
      "Screenshot of /about <playername> to confirm realtor job status",
      "Proof of ownership: screenshot of /rl info region or the player's /rl list --player",
    ],
  },
  "lack-of-progress": {
    reason: "lack-of-progress",
    label: "Lack of Progress",
    resolveDays: 7,
    criteria: [
      "No significant progress within 14 days of purchase",
      "Plot left empty for over 14 days",
    ],
    resolution:
      "Continue working on your build and ensure meaningful progress is made. " +
      "Share screenshots in the report thread. Once progress is deemed " +
      'significant (e.g., completed floor or shell), the report will be marked ' +
      'as "solved by owner."',
    evidence: [
      "If not started: logs (request via staff /ticket) or timestamped photo from 14 days prior",
      "If started: screenshots 14+ days apart showing no significant progress",
      "Proof of ownership: screenshot of /rl info region or the player's /rl list --player",
    ],
  },
  eyesore: {
    reason: "eyesore",
    label: "Eyesore",
    resolveDays: 14,
    criteria: [
      "Basic geometric forms without architectural detailing",
      "Minimal or absent use of windows or openings",
      "Excessive exterior clutter, or basic/repetitive materials",
    ],
    resolution:
      "Review your build and address any points listed in the report. For " +
      "tailored guidance, you may open a DCT ticket on Discord. Once changes " +
      'are made, post screenshots in your eviction report to have it marked as ' +
      '"solved by owner" and avoid eviction.',
    evidence: [
      "Screenshot of the plot",
      "Proof of ownership: screenshot of /rl info region or the player's /rl list --player",
    ],
  },
  "non-compliance": {
    reason: "non-compliance",
    label: "Non-Compliance",
    resolveDays: 14,
    criteria: [
      "Incorrect zoning or zoning mismatch",
      "Theme non-compliance",
      "Height violations (superstructure)",
    ],
    resolution:
      "Update your build to meet zoning and thematic requirements. If you are " +
      "unsure what needs to be corrected, open a DCT ticket for assistance. " +
      "Once revised, post screenshots in the report thread to resolve the report.",
    evidence: [
      "Depends on the specific issue — ask if unsure what evidence is required",
      "Proof of ownership: screenshot of /rl info region or the player's /rl list --player",
    ],
  },
};

/**
 * How a reason's resolve time reads in prose.
 *
 * Rental Limitations is zero days, and "0-day resolve" both reads badly and
 * suggests a deadline that does not exist — the policy's wording is that the
 * plot is simply evicted.
 */
export function describeResolveTime(resolveDays: number): string {
  return resolveDays === 0 ? "no resolve time" : `${resolveDays}-day resolve`;
}

/** `Sep 10, 2026` — the format used in eviction-report titles. */
export function formatEvictionDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export const REPORT_REASONS: ReportReason[] = [
  "inactivity",
  "plot-fairness",
  "rental-limitations",
  "lack-of-progress",
  "eyesore",
  "non-compliance",
];

export interface ReportKit {
  reason: ReasonDefinition;
  /** Today plus the reason's resolve time. */
  evictionDate: Date;
  evictionDateLabel: string;
  /** Suggested thread title, matching the `<plots> | <date>` convention. */
  suggestedTitle: string;
  commands: Array<{ label: string; command: string; note: string }>;
}

/**
 * Build the filing kit for one plot.
 *
 * `now` is injected rather than read here so the caller controls it — the
 * eviction date must be stable for a given render, and reading the clock deep
 * in a component is exactly the impurity the React compiler flags.
 */
export function buildReportKit(input: {
  reason: ReportReason;
  /** Every plot the report covers; merged plots are filed as one report. */
  plotIds: string[];
  ownerName: string | null;
  now: Date;
  /**
   * The filed report's thread URL, once one is linked to this plot.
   *
   * `/dct-eviction-notice add` takes the report link as its third argument, so
   * until a report exists the command can only carry a placeholder. Passing the
   * real URL turns the last transcription step in the kit into a copy button.
   */
  reportUrl?: string | null;
}): ReportKit {
  const reason = REASONS[input.reason];

  const evictionDate = new Date(input.now);
  evictionDate.setUTCDate(evictionDate.getUTCDate() + reason.resolveDays);

  const plots = input.plotIds.join("/");
  const owner = input.ownerName ?? "<owner>";
  const label = formatEvictionDate(evictionDate);

  return {
    reason,
    evictionDate,
    evictionDateLabel: label,
    suggestedTitle: `${plots} | ${label}`,
    commands: [
      {
        label: "Teleport to the plot",
        command: `/dct-tp ${input.plotIds[0]} ${reason.label}`,
        note: "Building-inspection use only; the guide notes this is monitored.",
      },
      {
        label: "Confirm playtime and job",
        command: `/about ${owner}`,
        note: "Playtime evidence for Inactivity, realtor status for a plot-limit breach.",
      },
      {
        label: "List everything the owner holds",
        command: `/rl list --player ${owner}`,
        note: "Ownership proof, required on every report.",
      },
      {
        label: "Send the eviction notice",
        command: `/dct-eviction-notice add ${owner} ${input.plotIds[0]} ${
          input.reportUrl ?? "<report link>"
        }`,
        note: input.reportUrl
          ? "Case sensitive. Attach a screenshot confirming it was sent."
          : "Case sensitive. Link the filed report above to fill in the URL.",
      },
      {
        label: "After the report is solved",
        command: `/dct-eviction-notice remove ${input.plotIds[0]}`,
        note: "The filer's responsibility once the report is marked solved.",
      },
    ],
  };
}

/**
 * Which report this plot should be filed under, worked out from what the app
 * already knows.
 *
 * Only three of the six reasons are detectable from data. **Inactivity** is
 * decided by playtime and enforcement; a plot-limit breach is decided by plot
 * counts, and files as either **Plot Fairness** or **Rental Limitations**
 * depending on the tenure of the plot in hand. All of that is in the cache. The
 * other three — Lack of Progress, Eyesore, Non-Compliance — are judgements
 * about what a build looks like, and nothing here has ever seen the plot. Those
 * are offered for the inspector to pick, and never guessed.
 *
 * Inactivity still wins when both apply: it covers the holder's whole position
 * rather than one category, and a banned holder cannot resolve a plot count
 * anyway. That holds even though Rental Limitations carries the harsher
 * zero-day resolve — filing the report that evicts on sight should be a
 * deliberate choice, so it is offered as *also applies* rather than selected.
 */
export interface ReasonDetection {
  reason: ReportReason | null;
  /** Why, in the words the report itself would use. */
  basis: string | null;
  /** Reasons that also apply, in priority order. */
  also: Array<{ reason: ReportReason; basis: string }>;
}

export interface DetectionInput {
  isBanned: boolean;
  /**
   * Deported on grounds that justify eviction: indefinite, or four months and
   * up. A limited deportation is served out, so it is not passed as true here.
   */
  isDeported: boolean;
  /** Measured 30-day playtime. Null means never measured — never assumed zero. */
  playtime30dMs: number | null;
  thresholdMs: number;
  /** The holder is over a §17 limit *and* this plot counts towards it. */
  overLimit: boolean;
  /**
   * Tenure of the plot being filed against.
   *
   * Since the 2026-09-04 policy a plot-limit breach splits by tenure:
   * "Exceeding legal plot limits for freehold plots" is Plot Fairness with a
   * 3-day resolve, while the same breach on a leasehold is Rental Limitations
   * and evicts on the date filed.
   *
   * The *counting* is unchanged. §17(5) and §17(7) cap what a player holds
   * "owned or rented", so freehold and leasehold plots are still counted
   * together against one limit; only which report you file changes.
   */
  contractType?: string | null;
  limitLabel?: string;
  limitCount?: number | null;
  limitValue?: number | null;
  needsRealtorCheck?: boolean;
}

export function detectReportReason(input: DetectionInput): ReasonDetection {
  const found: Array<{ reason: ReportReason; basis: string }> = [];

  if (input.isBanned) {
    found.push({ reason: "inactivity", basis: "Holder is banned." });
  } else if (input.isDeported) {
    found.push({
      reason: "inactivity",
      basis: "Holder is deported indefinitely or for four months or more.",
    });
  } else if (
    input.playtime30dMs !== null &&
    input.playtime30dMs < input.thresholdMs
  ) {
    const hours = input.playtime30dMs / 3_600_000;
    found.push({
      reason: "inactivity",
      basis: `Holder has ${hours.toFixed(1)}h playtime in the past 30 days, under the ${(
        input.thresholdMs / 3_600_000
      ).toFixed(0)}h minimum.`,
    });
  }

  if (input.overLimit) {
    const held =
      input.limitCount !== null && input.limitCount !== undefined
        ? `${input.limitCount} of ${input.limitValue} allowed`
        : "over the allowance";

    // Tenure decides the filing, not the count. Anything that is not explicitly
    // a leasehold files as Plot Fairness: that is the report with a resolve
    // time, so an unknown or missing contract type errs towards giving the
    // holder three days rather than evicting them on sight.
    const isLeasehold = input.contractType === "leasehold";
    const tenureNote = isLeasehold
      ? " This plot is a leasehold, so it files as Rental Limitations — evicted on the date filed, with no resolve time."
      : "";

    const basis = input.needsRealtorCheck
      ? `Holder has ${held} ${input.limitLabel ?? ""} plots — within §17(9)'s realtor allowance, so confirm the job with /about before filing.`
      : `Holder has ${held} ${input.limitLabel ?? ""} plots under PSA §17.`;

    found.push({
      reason: isLeasehold ? "rental-limitations" : "plot-fairness",
      basis: basis.replace(/\s+/g, " ") + tenureNote,
    });
  }

  const [first, ...rest] = found;
  return {
    reason: first?.reason ?? null,
    basis: first?.basis ?? null,
    also: rest,
  };
}

/**
 * A kit per reason, so switching reason in the UI is a selection rather than a
 * round trip. Cheap: each one is string assembly over the same inputs, and the
 * clock is still read once by the caller.
 */
export function buildReportKits(input: {
  plotIds: string[];
  ownerName: string | null;
  now: Date;
  reportUrl?: string | null;
}): Record<ReportReason, ReportKit> {
  return Object.fromEntries(
    REPORT_REASONS.map((reason) => [reason, buildReportKit({ ...input, reason })]),
  ) as Record<ReportReason, ReportKit>;
}
