import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  categoryDefinition,
  classifyPlot,
  effectiveLimit,
  limitApplies,
} from "../src/lib/plots/categories";
import {
  areAdjacent,
  evaluateMerge,
  isContiguous,
  type MergeCandidate,
} from "../src/lib/plots/merge";
import { exemptPairs } from "../src/lib/plots/limits-sql";
import {
  buildReportKit,
  buildReportKits,
  describeResolveTime,
  detectReportReason,
  formatEvictionDate,
  REPORT_REASONS,
} from "../src/lib/insights/report-kit";

describe("plot classification from tags", () => {
  it("reads zoning from the tag, not the id prefix", () => {
    assert.equal(classifyPlot("c176", ["commercial"]).category, "commercial");
    assert.equal(classifyPlot("r001", ["residential"]).category, "residential");
    assert.equal(classifyPlot("s010", ["skyscraper"]).category, "skyscraper");
  });

  it("classifies wl-f plots as farmland, which the prefix could not", () => {
    // PSA §12: 'F' or 'Wl-F' are farmland, limited to 1 by §17(7). Treating
    // `wl` as its own zoning missed that limit on 113 plots.
    const c = classifyPlot("wl-f139", ["farmland", "willow"]);
    assert.equal(c.category, "farmland");
    assert.equal(c.area, "willow");
    assert.equal(categoryDefinition(c.category).limit, 1);
  });

  it("keeps town and zoning as separate axes", () => {
    // 90 Oakridge plots are tagged commercial; the prefix says only *where*.
    const c = classifyPlot("or-12", ["oakridge", "commercial"]);
    assert.equal(c.category, "commercial");
    assert.equal(c.area, "oakridge");
  });

  it("falls back to the prefix only where no zoning tag exists", () => {
    // Black market and WBD plots carry no tag but do carry limits.
    assert.equal(classifyPlot("bm003", []).category, "black-market");
    assert.equal(classifyPlot("bm003", []).source, "prefix");
    assert.equal(classifyPlot("wbd-2", []).category, "wbd");
  });

  it("leaves untagged sub-regions as other rather than guessing", () => {
    for (const id of ["supermarket-1", "apts-3", "432office-1", "Billboard1"]) {
      const c = classifyPlot(id, []);
      assert.equal(c.category, "other", `${id} should not be zoned`);
      assert.equal(categoryDefinition(c.category).limit, null);
    }
  });
});

describe("limit exemptions", () => {
  it("exempts every plot inside a town (PSA §17(10))", () => {
    assert.equal(limitApplies("oakridge", "commercial"), false);
    assert.equal(limitApplies("oakridge", "residential"), false);
    assert.equal(limitApplies("aventura", "commercial"), false);
  });

  it("exempts Willow commercial but not Willow farmland", () => {
    assert.equal(limitApplies("willow", "commercial"), false);
    assert.equal(
      limitApplies("willow", "farmland"),
      true,
      "Willow farmland still counts against the farmland limit of 1",
    );
  });

  it("applies limits everywhere else", () => {
    assert.equal(limitApplies(null, "commercial"), true);
  });

  it("gives realtors +5 only where the PSA allows it", () => {
    assert.equal(effectiveLimit(categoryDefinition("commercial"), true), 25);
    assert.equal(effectiveLimit(categoryDefinition("commercial"), false), 20);
    // §17(9) excludes BM, ranch and Government Subsidised spaces.
    assert.equal(effectiveLimit(categoryDefinition("black-market"), true), 1);
    assert.equal(effectiveLimit(categoryDefinition("cbd"), true), 2);
    assert.equal(effectiveLimit(categoryDefinition("ranch"), true), 1);
  });
});

describe("merged plots", () => {
  const plot = (
    id: string,
    owner: string | null,
    x0: number,
    x1: number,
  ): MergeCandidate => ({
    worldUuid: "w",
    wgRegionId: id,
    ownerUuid: owner,
    bounds: { x0, x1, z0: 0, z1: 10 },
  });

  it("merges adjacent plots with the same owner", () => {
    // c176/c177 in live data sit 2 blocks apart with one owner.
    const result = evaluateMerge([plot("c176", "o1", 0, 40), plot("c177", "o1", 42, 80)]);
    assert.equal(result.status, "merged");
    assert.equal(result.ownerUuid, "o1");
  });

  it("refuses to merge plots with different owners", () => {
    const result = evaluateMerge([plot("a", "o1", 0, 10), plot("b", "o2", 11, 20)]);
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "different-owners");
  });

  it("refuses to merge plots that are far apart", () => {
    const result = evaluateMerge([plot("a", "o1", 0, 10), plot("b", "o1", 500, 510)]);
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "not-contiguous");
  });

  it("accepts a chain whose ends are far apart", () => {
    // Four merged plots in a row: the two ends never touch each other.
    const chain = [
      plot("a", "o1", 0, 20),
      plot("b", "o1", 21, 40),
      plot("c", "o1", 41, 60),
      plot("d", "o1", 61, 80),
    ];
    assert.equal(isContiguous(chain), true);
    assert.equal(evaluateMerge(chain).status, "merged");
    assert.equal(areAdjacent(chain[0], chain[3]), false, "the ends are not adjacent");
  });

  it("rejects a group with a plot of unknown boundary", () => {
    const result = evaluateMerge([
      plot("a", "o1", 0, 10),
      { worldUuid: "w", wgRegionId: "b", ownerUuid: "o1", bounds: null },
    ]);
    assert.equal(result.reason, "missing-dimensions");
  });

  it("treats touching and 2-block gaps as adjacent, 4 as not", () => {
    assert.equal(areAdjacent(plot("a", "o", 0, 10), plot("b", "o", 10, 20)), true);
    assert.equal(areAdjacent(plot("a", "o", 0, 10), plot("b", "o", 12, 20)), true);
    assert.equal(areAdjacent(plot("a", "o", 0, 10), plot("b", "o", 14, 20)), false);
  });
});

describe("inspector report kit", () => {
  const now = new Date("2026-09-04T00:00:00Z");

  it("dates an inactivity report 7 days out, per the Evictions Policy", () => {
    const kit = buildReportKit({ reason: "inactivity", plotIds: ["c176"], ownerName: "Bob", now });
    assert.equal(kit.reason.resolveDays, 7);
    assert.equal(kit.evictionDateLabel, "Sep 11, 2026");
  });

  it("dates a plot-fairness report 3 days out", () => {
    const kit = buildReportKit({ reason: "plot-fairness", plotIds: ["c176"], ownerName: "Bob", now });
    assert.equal(kit.evictionDateLabel, "Sep 7, 2026");
  });

  it("files merged plots as one report, matching the title convention", () => {
    const kit = buildReportKit({
      reason: "inactivity",
      plotIds: ["c176", "c177"],
      ownerName: "Bob",
      now,
    });
    assert.equal(kit.suggestedTitle, "c176/c177 | Sep 11, 2026");
  });

  it("fills the owner into every command", () => {
    const kit = buildReportKit({ reason: "inactivity", plotIds: ["c176"], ownerName: "Bob", now });
    assert.ok(kit.commands.some((c) => c.command === "/about Bob"));
    assert.ok(kit.commands.some((c) => c.command === "/rl list --player Bob"));
    assert.ok(
      kit.commands.some((c) => c.command.startsWith("/dct-eviction-notice add Bob c176")),
    );
  });

  it("dates a rental-limitations report on the day it is filed", () => {
    // 0-day resolve: the 2026-09-04 policy says the plot is simply evicted,
    // so there is no deadline to count forward to.
    const kit = buildReportKit({
      reason: "rental-limitations",
      plotIds: ["c176"],
      ownerName: "Bob",
      now,
    });
    assert.equal(kit.reason.resolveDays, 0);
    assert.equal(kit.evictionDateLabel, "Sep 4, 2026");
  });

  it("describes a zero-day resolve as no resolve time", () => {
    assert.equal(describeResolveTime(0), "no resolve time");
    assert.equal(describeResolveTime(3), "3-day resolve");
  });

  it("formats dates the way report titles do", () => {
    assert.equal(formatEvictionDate(new Date("2026-07-02T00:00:00Z")), "Jul 2, 2026");
  });
});

describe("limit exemption table generated for SQL", () => {
  const pairs = exemptPairs();
  const has = (category: string, area: string) =>
    pairs.some((p) => p.category === category && p.area === area);

  it("exempts every category inside a town", () => {
    for (const category of ["commercial", "residential", "farmland", "ranch"]) {
      assert.ok(has(category, "oakridge"), `${category} in Oakridge`);
      assert.ok(has(category, "aventura"), `${category} in Aventura`);
    }
  });

  it("exempts Willow commercial and nothing else in Willow", () => {
    assert.ok(has("commercial", "willow"));
    assert.equal(
      pairs.filter((p) => p.area === "willow").length,
      1,
      "Willow farmland, residential and the rest still count",
    );
  });

  it("never exempts a plot outside a listed area", () => {
    // The table drives a join; an area not in it counts towards the limit,
    // which is the safe direction for a value we have not seen before.
    assert.equal(pairs.some((p) => p.area === null || p.area === ""), false);
  });
});

describe("tag combinations", () => {
  it("reads farmland + residential as a ranch", () => {
    // §17(6) ranch and §17(7) farmland are separate limits of 1 each. Reading
    // the tags one at a time collapses them into one.
    const c = classifyPlot("fr001", ["farmland", "residential"]);
    assert.equal(c.category, "ranch");
    assert.equal(c.source, "tag");
    assert.equal(categoryDefinition(c.category).limit, 1);
  });

  it("leaves farmland without the residential tag as farmland", () => {
    assert.equal(classifyPlot("wl-f001", ["farmland", "willow"]).category, "farmland");
  });

  it("agrees with the id prefix on every ranch plot", () => {
    // The pair only ever appears on `fr*` ids, so the two signals corroborate.
    assert.equal(classifyPlot("fr001", []).category, "ranch");
  });

  it("keeps a plot tagged only residential as residential", () => {
    assert.equal(classifyPlot("r129", ["residential"]).category, "residential");
  });
});

describe("report reason detection", () => {
  const base = {
    isBanned: false,
    isDeported: false,
    playtime30dMs: 20 * 3_600_000,
    thresholdMs: 6 * 3_600_000,
    overLimit: false,
  };

  it("detects inactivity from measured playtime under the threshold", () => {
    const d = detectReportReason({ ...base, playtime30dMs: 1.5 * 3_600_000 });
    assert.equal(d.reason, "inactivity");
    assert.match(d.basis!, /1\.5h/);
  });

  it("detects inactivity from a ban or a deportation", () => {
    assert.equal(detectReportReason({ ...base, isBanned: true }).reason, "inactivity");
    assert.equal(detectReportReason({ ...base, isDeported: true }).reason, "inactivity");
  });

  it("never infers inactivity from unmeasured playtime", () => {
    // A player we have never measured is not a player with zero playtime.
    const d = detectReportReason({ ...base, playtime30dMs: null });
    assert.equal(d.reason, null);
  });

  it("detects plot fairness when the holder is over a limit", () => {
    const d = detectReportReason({
      ...base,
      overLimit: true,
      limitLabel: "farmland",
      limitCount: 3,
      limitValue: 1,
    });
    assert.equal(d.reason, "plot-fairness");
    assert.match(d.basis!, /3 of 1 allowed/);
  });

  it("files a leasehold limit breach as rental limitations, not plot fairness", () => {
    // The 2026-09-04 policy moved "exceeding legal plot limits for leasehold
    // plots" out of Plot Fairness and into Rental Limitations, which has no
    // resolve time.
    const d = detectReportReason({
      ...base,
      overLimit: true,
      limitLabel: "commercial",
      limitCount: 23,
      limitValue: 20,
      contractType: "leasehold",
    });
    assert.equal(d.reason, "rental-limitations");
    assert.match(d.basis!, /leasehold/);
  });

  it("keeps a freehold limit breach on plot fairness", () => {
    const d = detectReportReason({
      ...base,
      overLimit: true,
      limitCount: 23,
      limitValue: 20,
      contractType: "freehold",
    });
    assert.equal(d.reason, "plot-fairness");
  });

  it("falls back to plot fairness when the tenure is unknown", () => {
    // Plot Fairness is the report that carries a resolve time, so an unknown
    // contract type must not silently produce an evict-on-sight filing.
    for (const contractType of [null, undefined, ""]) {
      const d = detectReportReason({
        ...base,
        overLimit: true,
        limitCount: 23,
        limitValue: 20,
        contractType,
      });
      assert.equal(d.reason, "plot-fairness", String(contractType));
    }
  });

  it("still prefers inactivity over a leasehold limit breach", () => {
    const d = detectReportReason({
      ...base,
      isBanned: true,
      overLimit: true,
      contractType: "leasehold",
    });
    assert.equal(d.reason, "inactivity");
    assert.deepEqual(
      d.also.map((a) => a.reason),
      ["rental-limitations"],
    );
  });

  it("says to confirm the realtor job when that is what stands in the way", () => {
    const d = detectReportReason({
      ...base,
      overLimit: true,
      limitCount: 23,
      limitValue: 20,
      needsRealtorCheck: true,
    });
    assert.match(d.basis!, /\/about/);
  });

  it("prefers inactivity when both apply, keeping the other as also-applies", () => {
    // Inactivity covers the whole holding, and a banned holder cannot resolve a
    // plot count anyway.
    const d = detectReportReason({ ...base, isBanned: true, overLimit: true });
    assert.equal(d.reason, "inactivity");
    assert.deepEqual(
      d.also.map((a) => a.reason),
      ["plot-fairness"],
    );
  });

  it("detects nothing for a compliant, active holder", () => {
    const d = detectReportReason(base);
    assert.equal(d.reason, null);
    assert.equal(d.also.length, 0);
  });

  it("builds a kit for every reason, each with its own date and title", () => {
    const kits = buildReportKits({
      plotIds: ["c176", "c177"],
      ownerName: "Bob",
      now: new Date("2026-09-04T00:00:00Z"),
    });
    assert.equal(kits["plot-fairness"].evictionDateLabel, "Sep 7, 2026");
    assert.equal(kits["rental-limitations"].evictionDateLabel, "Sep 4, 2026");
    assert.equal(kits.inactivity.evictionDateLabel, "Sep 11, 2026");
    assert.equal(kits.eyesore.evictionDateLabel, "Sep 18, 2026");
    assert.equal(kits.eyesore.suggestedTitle, "c176/c177 | Sep 18, 2026");
    for (const reason of REPORT_REASONS) {
      assert.ok(kits[reason].reason.resolution.length > 0, reason);
      assert.ok(kits[reason].reason.evidence.length > 0, reason);
    }
  });
});
