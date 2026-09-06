/**
 * Token bucket + concurrency semaphore.
 *
 * Three of the four upstream APIs publish no rate limits at all, so we impose
 * conservative ones on ourselves. The fourth (Treasury) publishes tight
 * per-endpoint quotas which we honour with a safety margin.
 *
 * Time is injected so the tests can drive this deterministically instead of
 * sleeping.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface BucketOptions {
  /** Sustained request budget. */
  requestsPerMinute: number;
  /** Burst allowance. Defaults to one second's worth, minimum 1. */
  burst?: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private capacity: number;
  private ratePerMs: number;
  /** Serialises waiters so tokens are handed out first-come-first-served. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    options: BucketOptions,
    private clock: Clock = systemClock,
  ) {
    this.ratePerMs = options.requestsPerMinute / 60_000;
    this.capacity = Math.max(
      1,
      options.burst ?? Math.ceil(options.requestsPerMinute / 60),
    );
    this.tokens = this.capacity;
    this.lastRefill = clock.now();
  }

  /**
   * Temporarily slow the refill rate. Used when a source reports it is running
   * low on quota, and to serve out a `Retry-After` cooldown.
   */
  private penaltyUntil = 0;

  penalise(ms: number): void {
    this.penaltyUntil = Math.max(this.penaltyUntil, this.clock.now() + ms);
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
  }

  /** Milliseconds until at least one token is available. */
  private delayForToken(): number {
    this.refill();
    const penaltyWait = Math.max(0, this.penaltyUntil - this.clock.now());
    if (this.tokens >= 1) return penaltyWait;
    const tokenWait = Math.ceil((1 - this.tokens) / this.ratePerMs);
    return Math.max(tokenWait, penaltyWait);
  }

  /** Blocks until a token is available, then consumes it. */
  async acquire(): Promise<void> {
    const run = this.queue.then(async () => {
      // Loop rather than sleep-once: a penalty may be extended while waiting.
      for (;;) {
        const wait = this.delayForToken();
        if (wait <= 0) break;
        await this.clock.sleep(wait);
      }
      this.tokens -= 1;
    });
    // Keep the chain alive even if a waiter is cancelled upstream.
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** Caps how many requests to one source may be in flight at once. */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

/**
 * A source's throttle: one bucket per endpoint group plus a shared concurrency
 * cap. Treasury needs per-endpoint groups because its documented quotas differ
 * by route (60/min for `by-player`, 120/min for `balance`, and so on).
 */
export class Throttle {
  private buckets = new Map<string, TokenBucket>();
  private semaphore: Semaphore;

  constructor(
    private readonly groups: Record<string, BucketOptions>,
    concurrency: number,
    private readonly clock: Clock = systemClock,
    private readonly defaultGroup = "default",
  ) {
    this.semaphore = new Semaphore(concurrency);
  }

  private bucketFor(group: string): TokenBucket {
    const key = this.groups[group] ? group : this.defaultGroup;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      const options = this.groups[key];
      if (!options) {
        throw new Error(
          `No rate-limit bucket configured for group "${group}" and no "${this.defaultGroup}" fallback`,
        );
      }
      bucket = new TokenBucket(options, this.clock);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  /** Acquire a token and a concurrency slot; returns the release function. */
  async acquire(group: string): Promise<() => void> {
    await this.bucketFor(group).acquire();
    return this.semaphore.acquire();
  }

  penalise(group: string, ms: number): void {
    this.bucketFor(group).penalise(ms);
  }

  /** Slow every group for this source — used for blanket cooldowns. */
  penaliseAll(ms: number): void {
    for (const group of Object.keys(this.groups)) {
      this.bucketFor(group).penalise(ms);
    }
  }
}
