import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runPooled } from "../src/lib/sync/pool";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("runPooled", () => {
  it("never exceeds the configured width", async () => {
    let inFlight = 0;
    let peak = 0;

    await runPooled(Array.from({ length: 50 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });

    assert.equal(peak, 4, `expected at most 4 concurrent, saw ${peak}`);
  });

  it("processes every item exactly once", async () => {
    const items = Array.from({ length: 37 }, (_, i) => i);
    const seen: number[] = [];

    const result = await runPooled(items, 5, async (item) => {
      await tick();
      seen.push(item);
    });

    assert.equal(result.done, 37);
    assert.deepEqual([...seen].sort((a, b) => a - b), items);
  });

  it("never runs more lanes than there are items", async () => {
    let inFlight = 0;
    let peak = 0;

    await runPooled([1, 2], 16, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });

    assert.equal(peak, 2);
  });

  it("isolates a failing item instead of discarding the batch", async () => {
    // The whole point: one bad player must not cost the other 149 their work.
    const completed: number[] = [];

    const result = await runPooled(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async (item) => {
        await tick();
        if (item % 5 === 0) throw new Error(`item ${item} is bad`);
        completed.push(item);
      },
    );

    assert.equal(result.failed, 4);
    assert.equal(result.done, 20, "failures still count as attempted");
    assert.equal(completed.length, 16);
    assert.equal(result.aborted, null);
  });

  it("stops pulling new work on a fatal error", async () => {
    class Fatal extends Error {}
    let attempted = 0;

    const result = await runPooled(
      Array.from({ length: 100 }, (_, i) => i),
      2,
      async (item) => {
        attempted += 1;
        await tick();
        if (item === 10) throw new Fatal("circuit open");
      },
      { isFatal: (error) => error instanceof Fatal },
    );

    assert.ok(result.aborted instanceof Fatal);
    // In-flight work finishes, but the remaining ~90 are never started.
    assert.ok(
      attempted < 30,
      `expected the pool to stop early, but it attempted ${attempted}`,
    );
  });

  it("reports progress at the requested interval", async () => {
    const reports: number[] = [];

    await runPooled(
      Array.from({ length: 25 }, (_, i) => i),
      3,
      async () => {
        await tick();
      },
      { progressEvery: 10, onProgress: (done) => void reports.push(done) },
    );

    assert.deepEqual(reports, [10, 20]);
  });

  it("handles an empty batch without spawning a lane", async () => {
    let called = false;
    const result = await runPooled([], 4, async () => {
      called = true;
    });

    assert.equal(called, false);
    assert.deepEqual(
      { done: result.done, failed: result.failed, aborted: result.aborted },
      { done: 0, failed: 0, aborted: null },
    );
  });
});
