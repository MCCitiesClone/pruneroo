import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Side-effect import: must precede the module under test.
import "./_env";
import { parseAtRiskFilters } from "../src/lib/insights/filters";

/**
 * The page and the CSV export must agree. They previously parsed the query
 * string separately and drifted: `Number(null)` is 0, not NaN, so a missing
 * `hours` became a 0-hour threshold in the export only — silently dropping
 * every inactive row from the download while the page still listed them.
 */
describe("at-risk filter parsing", () => {
  it("falls back to the configured threshold when hours is absent", () => {
    assert.equal(parseAtRiskFilters({}).thresholdHours, 6);
    assert.equal(
      parseAtRiskFilters(new URLSearchParams()).thresholdHours,
      6,
      "URLSearchParams.get returns null, which Number() turns into 0",
    );
  });

  it("honours an explicit zero threshold", () => {
    // Meaningfully different from "absent": it drops inactivity-only rows.
    assert.equal(parseAtRiskFilters({ hours: "0" }).thresholdHours, 0);
    assert.equal(
      parseAtRiskFilters(new URLSearchParams("hours=0")).thresholdHours,
      0,
    );
  });

  it("ignores a nonsense threshold rather than silently using 0", () => {
    assert.equal(parseAtRiskFilters({ hours: "abc" }).thresholdHours, 6);
    assert.equal(parseAtRiskFilters({ hours: "-5" }).thresholdHours, 6);
  });

  it("parses identically from both query shapes", () => {
    const qs = "hours=12&reason=banned&reason=deported&role=titleholder" +
      "&authority=DCGovernment&excluded=1&unknown=1&contract=freehold&dir=desc";
    const fromUrl = parseAtRiskFilters(new URLSearchParams(qs));
    const fromObject = parseAtRiskFilters({
      hours: "12",
      reason: ["banned", "deported"],
      role: "titleholder",
      authority: "DCGovernment",
      excluded: "1",
      unknown: "1",
      contract: "freehold",
      dir: "desc",
    });
    assert.deepEqual(fromUrl, fromObject);
    assert.equal(fromUrl.thresholdHours, 12);
    assert.deepEqual(fromUrl.reasons, ["banned", "deported"]);
    assert.equal(fromUrl.authority, "DCGovernment");
    assert.equal(fromUrl.includeExcluded, true);
  });

  it("hides excluded players unless explicitly asked", () => {
    assert.equal(parseAtRiskFilters({}).includeExcluded, false);
    assert.equal(parseAtRiskFilters({ excluded: "1" }).includeExcluded, true);
  });

  it("trims an authority query", () => {
    assert.equal(
      parseAtRiskFilters({ authority: "  DCGovernment " }).authority,
      "DCGovernment",
    );
  });

  it("defaults world and authority to the actionable slice", () => {
    // The list opens on government-held plots in the main world rather than on
    // everything, because that is the slice worth reviewing.
    const d = parseAtRiskFilters({});
    assert.equal(d.worldUuid, "b04fccfd-b696-4c85-8497-aecbb0277883");
    assert.equal(d.authority, "5aa02d16-43fb-4ac1-b4d2-a86fc986dfb2");
  });

  it("treats 'all' as the explicit opt-out, not a search term", () => {
    const wide = parseAtRiskFilters({ world: "all", authority: "all" });
    assert.equal(wide.worldUuid, undefined);
    assert.equal(wide.authority, undefined);
  });

  it("keeps the other default when only one is overridden", () => {
    const f = parseAtRiskFilters({ authority: "KattoDE" });
    assert.equal(f.authority, "KattoDE");
    assert.equal(f.worldUuid, "b04fccfd-b696-4c85-8497-aecbb0277883");
  });

  it("rejects unknown reasons, roles and sorts", () => {
    const f = parseAtRiskFilters({ reason: "bogus", role: "bogus", sort: "bogus" });
    assert.equal(f.reasons, undefined, "falls back to all reasons");
    assert.equal(f.roles, undefined, "falls back to ownership roles");
    assert.equal(f.sort, "player");
  });
});
