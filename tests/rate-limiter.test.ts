import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  Semaphore,
  Throttle,
  TokenBucket,
  type Clock,
} from "../src/lib/http/rate-limiter";

/**
 * A virtual clock: `sleep` jumps time forward instead of waiting, so budget
 * behaviour is asserted deterministically rather than by wall-clock timing.
 */
function fakeClock(): Clock & { advance: (ms: number) => void; time: () => number } {
  let now = 0;
  const pending: Array<{ at: number; resolve: () => void }> = [];

  const drain = () => {
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (pending[i].at <= now) {
        const [entry] = pending.splice(i, 1);
        entry.resolve();
      }
    }
  };

  return {
    now: () => now,
    sleep(ms: number) {
      return new Promise<void>((resolve) => {
        pending.push({ at: now + ms, resolve });
        // Let the scheduled wake-up happen on the next turn of the loop.
        queueMicrotask(() => {
          now += ms;
          drain();
        });
      });
    },
    advance(ms: number) {
      now += ms;
      drain();
    },
    time: () => now,
  };
}

describe("TokenBucket", () => {
  it("does not exceed the configured budget over time", async () => {
    const clock = fakeClock();
    // 60/min with a burst of 1 => one request per second.
    const bucket = new TokenBucket(
      { requestsPerMinute: 60, burst: 1 },
      clock,
    );

    for (let i = 0; i < 10; i += 1) {
      await bucket.acquire();
    }

    // 10 requests at 1/sec must span at least 9 seconds of virtual time.
    assert.ok(
      clock.time() >= 9_000,
      `expected >= 9000ms of throttling, got ${clock.time()}ms`,
    );
  });

  it("allows a burst up to capacity, then throttles", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ requestsPerMinute: 60, burst: 5 }, clock);

    for (let i = 0; i < 5; i += 1) await bucket.acquire();
    assert.equal(clock.time(), 0, "burst should not wait");

    await bucket.acquire();
    assert.ok(clock.time() >= 1_000, "sixth request should wait for a refill");
  });

  it("honours a penalty applied mid-flight", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ requestsPerMinute: 6000, burst: 10 }, clock);

    bucket.penalise(5_000);
    await bucket.acquire();

    assert.ok(
      clock.time() >= 5_000,
      `penalty should delay acquisition, waited ${clock.time()}ms`,
    );
  });
});

describe("Semaphore", () => {
  it("caps concurrent holders", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, async () => {
        const release = await semaphore.acquire();
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        release();
      }),
    );

    assert.equal(peak, 2);
  });
});

describe("Throttle", () => {
  it("charges each endpoint group against its own budget", async () => {
    const clock = fakeClock();
    const throttle = new Throttle(
      {
        default: { requestsPerMinute: 60, burst: 1 },
        cheap: { requestsPerMinute: 6000, burst: 100 },
      },
      4,
      clock,
    );

    // The generous group should not be slowed by the strict one.
    for (let i = 0; i < 20; i += 1) {
      (await throttle.acquire("cheap"))();
    }
    assert.equal(clock.time(), 0);

    (await throttle.acquire("default"))();
    (await throttle.acquire("default"))();
    assert.ok(clock.time() >= 1_000, "strict group must still throttle");
  });

  /**
   * The prune sweep processes players through a pool wider than this
   * concurrency, on the explicit argument that the throttle — not the caller —
   * is what bounds requests in flight. If that stopped holding, widening the
   * pool would silently multiply the real rate against a third party, so it is
   * asserted rather than assumed.
   */
  it("bounds requests in flight however many callers pile in", async () => {
    const throttle = new Throttle(
      { default: { requestsPerMinute: 600_000, burst: 1_000 } },
      2,
    );

    let inFlight = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 40 }, async () => {
        const release = await throttle.acquire("default");
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        release();
      }),
    );

    assert.equal(peak, 2, `40 concurrent callers must still yield 2, saw ${peak}`);
  });

  it("still meters the rate when callers arrive in parallel", async () => {
    const clock = fakeClock();
    // 60/min with no burst: the 2nd and 3rd acquires must each wait a second.
    const throttle = new Throttle(
      { default: { requestsPerMinute: 60, burst: 1 } },
      8,
      clock,
    );

    await Promise.all(
      Array.from({ length: 3 }, async () => {
        (await throttle.acquire("default"))();
      }),
    );

    assert.ok(
      clock.time() >= 2_000,
      `parallel callers must not bypass the bucket (advanced ${clock.time()}ms)`,
    );
  });

  it("falls back to the default bucket for unknown groups", async () => {
    const clock = fakeClock();
    const throttle = new Throttle(
      { default: { requestsPerMinute: 6000, burst: 10 } },
      2,
      clock,
    );
    const release = await throttle.acquire("does-not-exist");
    release();
  });
});
