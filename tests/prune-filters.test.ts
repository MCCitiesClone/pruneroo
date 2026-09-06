import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Side-effect import: must precede the module under test.
import "./_env";
import { parsePruneFilters } from "../src/lib/insights/filters";

/**
 * The prune thresholds carry the same trap as the at-risk one, with a worse
 * failure mode. `Number(null)` is 0, so a missing `days` parsed naively becomes
 * a 0-day dormancy threshold — which matches every player who has ever logged
 * in, and presents all ~93,000 of them as prunable. A list that over-reports
 * who can have their money taken is far more dangerous than one that
 * under-reports, so the fallback is asserted in both query shapes.
 */
describe("prune filter parsing", () => {
  it("falls back to the configured defaults when nothing is supplied", () => {
    assert.equal(parsePruneFilters({}).inactivityDays, 90);
    assert.equal(parsePruneFilters({}).minBalance, 0);
    assert.equal(
      parsePruneFilters(new URLSearchParams()).inactivityDays,
      90,
      "URLSearchParams.get returns null, which Number() turns into 0",
    );
  });

  it("refuses a zero or negative dormancy threshold", () => {
    // Unlike the at-risk hours threshold, 0 days is never meaningful here: it
    // would mean "dormant since now", i.e. everyone.
    assert.equal(parsePruneFilters({ days: "0" }).inactivityDays, 90);
    assert.equal(parsePruneFilters({ days: "-5" }).inactivityDays, 90);
    assert.equal(parsePruneFilters({ days: "abc" }).inactivityDays, 90);
  });

  it("honours an explicit zero balance floor", () => {
    // 0 is meaningful for the balance: the rule is "> 0", i.e. any credit.
    assert.equal(parsePruneFilters({ min: "0" }).minBalance, 0);
    assert.equal(parsePruneFilters({ min: "1000" }).minBalance, 1000);
  });

  it("ignores a nonsense balance floor rather than using 0 by accident", () => {
    assert.equal(parsePruneFilters({ min: "abc" }).minBalance, 0);
    assert.equal(parsePruneFilters({ min: "-1" }).minBalance, 0);
  });

  it("parses identically from both query shapes", () => {
    const qs = "days=180&min=500&q=Tommy&excluded=1&sort=last_seen&dir=asc";
    assert.deepEqual(
      parsePruneFilters(new URLSearchParams(qs)),
      parsePruneFilters({
        days: "180",
        min: "500",
        q: "Tommy",
        excluded: "1",
        sort: "last_seen",
        dir: "asc",
      }),
    );
  });

  it("defaults to the biggest balances first", () => {
    assert.equal(parsePruneFilters({}).sort, "balance");
    assert.equal(parsePruneFilters({}).direction, "desc");
    assert.equal(parsePruneFilters({ sort: "nonsense" }).sort, "balance");
  });

  it("hides excluded players unless asked", () => {
    assert.equal(parsePruneFilters({}).includeExcluded, false);
    assert.equal(parsePruneFilters({ excluded: "1" }).includeExcluded, true);
  });

  /**
   * Page size doubles as the number of balances a single page load will read
   * upstream, so it is a whitelist, not a number. An unchecked ?size=100000
   * would turn one page view into a flood of requests against someone else's
   * game server.
   */
  it("defaults to one page of the configured size", () => {
    assert.equal(parsePruneFilters({}).limit, 25);
    assert.equal(parsePruneFilters({}).offset, 0);
  });

  it("accepts only whitelisted page sizes", () => {
    assert.equal(parsePruneFilters({ size: "50" }).limit, 50);
    assert.equal(parsePruneFilters({ size: "100000" }).limit, 25);
    assert.equal(parsePruneFilters({ size: "37" }).limit, 25);
    assert.equal(parsePruneFilters({ size: "-1" }).limit, 25);
    assert.equal(parsePruneFilters({ size: "abc" }).limit, 25);
  });

  it("turns a page number into an offset", () => {
    assert.equal(parsePruneFilters({ page: "3" }).offset, 50);
    assert.equal(parsePruneFilters({ page: "2", size: "50" }).offset, 50);
  });

  it("clamps a nonsense page to the first one", () => {
    assert.equal(parsePruneFilters({ page: "0" }).offset, 0);
    assert.equal(parsePruneFilters({ page: "-4" }).offset, 0);
    assert.equal(parsePruneFilters({ page: "abc" }).offset, 0);
    // A fractional page would produce a fractional OFFSET.
    assert.equal(parsePruneFilters({ page: "2.7" }).offset, 25);
  });

  it("treats a blank search as no filter", () => {
    assert.equal(parsePruneFilters({ q: "   " }).search, undefined);
    assert.equal(parsePruneFilters({ q: " Tommy " }).search, "Tommy");
  });
});
