import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dedupeBy } from "../src/lib/db/dedupe";
import { normalizePunishment } from "../src/lib/sources/punishments/client";

/**
 * Regression cover for a real production failure.
 *
 * Live ban page 276 contained two records with an identical
 * (victim, start-second, reason) — so an identical synthetic id. Postgres
 * rejects `ON CONFLICT DO UPDATE` affecting a row twice in one statement, which
 * failed the batch, failed the job, and restarted the crawl at page 1 forever.
 */
describe("batch dedupe before upsert", () => {
  it("collapses duplicate keys, keeping the last occurrence", () => {
    const rows = [
      { id: "a", v: 1 },
      { id: "b", v: 2 },
      { id: "a", v: 3 },
    ];
    const out = dedupeBy(rows, (r) => r.id);
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.find((r) => r.id === "a"),
      { id: "a", v: 3 },
    );
  });

  it("leaves small or unique batches untouched", () => {
    assert.deepEqual(dedupeBy([], (r: { id: string }) => r.id), []);
    const one = [{ id: "x" }];
    assert.equal(dedupeBy(one, (r) => r.id), one);
  });

  it("collapses the real duplicate that broke ban page 276", () => {
    // Two identical records as served by the live API.
    const record = {
      victimUuid: "9d2c6b4a-1111-4222-8333-444455556666",
      victimUsername: "PokimaneAlt",
      operatorUuid: "00000000-0000-0000-0000-000000000000",
      operatorUsername: "Console",
      reason: "1.1 - Trolling (B:2)",
      active: false,
      start: 1641014024,
      end: 0,
      label: "Permanent",
    };
    const batch = [
      normalizePunishment("BAN", record),
      normalizePunishment("BAN", record),
    ];
    assert.equal(batch[0].id, batch[1].id, "both hash to one id");
    assert.equal(dedupeBy(batch, (p) => p.id).length, 1);
  });
});
