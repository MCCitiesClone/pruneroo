import { z } from "zod";

/**
 * Trailing slashes are stripped so every call site can build paths as
 * `${baseUrl}/whatever` without worrying about doubling up.
 */
const baseUrl = z.url().transform((value) => value.replace(/\/+$/, ""));

/**
 * A blank value in a .env file is "not configured", not "configured as empty".
 * Without this, an untouched `TREASURY_TOKEN=` line fails validation.
 */
/**
 * A tunable number that falls back to its default when the line is left blank.
 *
 * `z.coerce.number()` alone reads `FOO=` as `Number("") === 0`, which is silent
 * and, for an alert floor, actively harmful: a blank
 * `DISCORD_PRUNE_MIN_BALANCE` would announce every dormant player holding a
 * single dollar. A blank line means "not configured", exactly as it does for
 * the secrets below.
 */
const numberOrDefault = (fallback: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.coerce.number().nonnegative().default(fallback),
  );

const optionalSecret = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });

const schema = z.object({
  DATABASE_URL: z.url(),

  REALTY_BASE_URL: baseUrl,
  ANALYTICS_BASE_URL: baseUrl,
  TREASURY_BASE_URL: baseUrl,
  PUNISHMENTS_BASE_URL: baseUrl,
  /**
   * The HTML thread listing, not the RSS feed. RSS is hard capped at 100 items,
   * ignores every pagination parameter, and omits the thread prefix that says
   * whether a report is still live.
   */
  FORUM_EVICTION_LISTING_URL: baseUrl.default(
    "https://www.democracycraft.net/forums/eviction-reports.62/",
  ),
  /**
   * Archived eviction reports. Threads appear to be moved here once dealt
   * with, so an archived report records history for a region without
   * suppressing it from review.
   */
  FORUM_ARCHIVE_LISTING_URL: baseUrl.default(
    "https://www.democracycraft.net/forums/archive.158/",
  ),
  /**
   * Plot names in eviction reports always refer to this world, so matching is
   * scoped to it. Without the scope a title could match an identically-named
   * plot in another world — 19 regions live outside Reveille, and one report
   * had already been mislinked to NewVault.
   */
  FORUM_REGION_WORLD: z.string().default("Reveille"),

  // Optional so the app still boots (and the other three sources still sync)
  // when no Treasury key is on hand. The Treasury client refuses to run without
  // it rather than sending unauthenticated requests.
  TREASURY_TOKEN: optionalSecret,

  ANALYTICS_USERNAME: optionalSecret,
  ANALYTICS_PASSWORD: optionalSecret,

  // The eviction-reports forum is not guest-readable: both its HTML and RSS
  // return 403. Paste the `xf_user` remember-me cookie from a logged-in
  // browser session, e.g. `xf_user=123,abc...`.
  FORUM_COOKIE: optionalSecret,

  /**
   * Thread prefixes that mean a report is finished. Anything else counts as
   * active. Configurable because the real vocabulary can only be read off live
   * data, which needs the cookie above — /sync lists every prefix observed so
   * this can be corrected without a code change.
   */
  EVICTION_RESOLVED_PREFIXES: z
    .string()
    // Observed on the live listing: Pending, Auction Required, Auctioning,
    // Staff Action, Payment Required, Deadline Passed, Solved. Only "Solved"
    // means the report is finished — "Deadline Passed" in particular is a call
    // to act, not a conclusion. Threads are also moved to the archive when
    // done, which is the stronger signal.
    .default("solved,resolved,completed,closed,denied,rejected,withdrawn")
    .transform((value) =>
      value
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean),
    ),

  /**
   * Discord webhook URLs, one per alert channel. Each is independent: an unset
   * one disables only its own notifier, so the other two still run.
   *
   * Nothing is sent until the channel has been *seeded* — see
   * `src/lib/notify/dispatch.ts`. The first run of a newly configured webhook
   * records everything that already qualifies without sending it, because
   * "every ban we have ever stored" is not news and would be several thousand
   * messages.
   */
  /**
   * Where this app is reachable, used to link Discord alerts back to the page
   * that explains them. Unset means the alerts carry no links.
   *
   * Validated as a URL rather than as a plain string. This value is not only
   * displayed: it becomes the `url` on every Discord embed, and a scheme-less
   * value like `pruneroo.example.com` is rejected by Discord with
   * `400 {"embeds": ["0"]}`, which names neither the field nor the variable
   * that caused it. Every notifier fails at once and the message points at
   * nothing. Failing at boot, naming APP_BASE_URL, is the cheaper failure.
   */
  APP_BASE_URL: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() || undefined : value),
    baseUrl.optional(),
  ),

  DISCORD_WEBHOOK_PUNISHMENTS: optionalSecret,
  DISCORD_WEBHOOK_PRUNE: optionalSecret,
  DISCORD_WEBHOOK_AT_RISK: optionalSecret,

  /**
   * Balance a dormant player must exceed to be worth announcing.
   *
   * Deliberately separate from `PRUNE_MIN_BALANCE`, which is the floor for the
   * /prune *list*: that is set to 0 so the page shows every credit, and alerting
   * on every one of those would be noise. Compared in SQL as a numeric literal,
   * never as a JS float.
   */
  DISCORD_PRUNE_MIN_BALANCE: numberOrDefault(10_000),

  /**
   * Items per Discord message. Ten is the hard cap on embeds per webhook
   * payload, not a preference.
   */
  DISCORD_ITEMS_PER_MESSAGE: numberOrDefault(10).pipe(z.number().positive().max(10)),

  /**
   * Items one notifier run will announce, per channel.
   *
   * A bound on burst, not on total: whatever is left over is picked up by the
   * next run, so nothing is dropped. It matters most for prune, where the
   * balance backfill is still draining ~61k players and can qualify thousands
   * in an afternoon — without a cap that arrives as one uninterruptible flood.
   */
  DISCORD_MAX_ITEMS_PER_RUN: numberOrDefault(50).pipe(z.number().positive().max(1000)),

  SYNC_WORKER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  // The window is fixed at 30 days by the upstream metric itself
  // (`online_activity.active_playtime_30d`), so only the threshold is tunable.
  INACTIVITY_THRESHOLD_HOURS: z.coerce.number().nonnegative().default(6),

  /**
   * Prune thresholds: how long since last login makes a player dormant, and
   * how much money makes them worth reclaiming from. Both are tunable per
   * request from the page; these are the defaults.
   */
  PRUNE_INACTIVITY_DAYS: z.coerce.number().positive().default(90),
  /** Exclusive floor — the rule is "balance > this", so 0 means any credit. */
  PRUNE_MIN_BALANCE: z.coerce.number().nonnegative().default(0),

  /**
   * Players priced per `treasury.prune.sweep` pass (one pass per minute).
   *
   * This is the pacing dial for the roster backfill: ~61k dormant players at
   * 150/min finishes in around seven hours while leaving the treasury job slot
   * free between passes, so the other treasury sweeps are never starved. Raise it to
   * finish sooner at the cost of a heavier sustained load upstream.
   */
  PRUNE_SWEEP_BATCH: z.coerce.number().positive().max(2000).default(150),
  /**
   * Players the sweep works on at once.
   *
   * This does **not** raise the request rate and cannot breach the budget: every
   * call still goes through the shared throttle, which holds both the
   * per-endpoint token bucket and a concurrency semaphore (2 for treasury), so
   * at most two requests are ever in flight whatever this is set to. What it
   * fixes is the opposite problem — awaiting each player in turn left the
   * allowance largely unused, running at 12-64 players/min against a ceiling
   * near 240. Above about 4 the semaphore is the binding constraint and there is
   * nothing further to gain.
   */
  PRUNE_SWEEP_CONCURRENCY: z.coerce.number().positive().max(16).default(4),
  /** Dormant balances re-read per pass, and how stale one may get first. */
  PRUNE_BALANCE_BATCH: z.coerce.number().positive().max(2000).default(300),
  PRUNE_BALANCE_MAX_AGE_HOURS: z.coerce.number().positive().default(24),

  /**
   * Rows per page on /prune. Purely a display concern now: the page serves
   * stored balances and makes no upstream requests of its own.
   */
  PRUNE_PAGE_SIZE: z.coerce.number().positive().max(100).default(25),

  /**
   * The at-risk list opens on the slice that is actually actionable:
   * government-held plots in the main world. Both are ordinary filters — the
   * advanced panel can widen or clear them, and `?world=all` / `?authority=all`
   * turn each off explicitly.
   */
  DEFAULT_WORLD_UUID: z
    .string()
    .default("b04fccfd-b696-4c85-8497-aecbb0277883"), // Reveille
  DEFAULT_AUTHORITY: z
    .string()
    .default("5aa02d16-43fb-4ac1-b4d2-a86fc986dfb2"), // DCGovernment
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        `Copy .env.example to .env and fill in the missing values.`,
    );
  }

  cached = parsed.data;
  return cached;
}
