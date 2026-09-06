import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PUNISHMENT_TYPES } from "../src/lib/sources/punishments/schemas";

/**
 * The punishments service routes by a type slug in the path, and an
 * *unrecognised* slug does not 404 — it silently returns the BAN list. So
 * `/punishments/active/1`, `/punishments/all/1` and `/punishments/nonsense/1`
 * all return bans verbatim.
 *
 * That makes a typo indistinguishable from correct behaviour at runtime: the
 * crawl would happily store the ban list under the wrong type. Only these four
 * slugs are real, and this test pins them.
 */
describe("punishment type slugs", () => {
  it("covers exactly the four real endpoints", () => {
    assert.deepEqual([...PUNISHMENT_TYPES], ["BAN", "MUTE", "WARN", "KICK"]);
  });

  it("maps to lowercase path and stats slugs", () => {
    for (const type of PUNISHMENT_TYPES) {
      const slug = type.toLowerCase();
      assert.match(slug, /^(ban|mute|warn|kick)$/);
      assert.equal(`/punishments/${slug}/1`, `/punishments/${slug}/1`);
      assert.equal(`/stats/${slug}`, `/stats/${slug}`);
    }
  });

  it("excludes the pseudo-types that silently alias to bans", () => {
    for (const fake of ["all", "active", "expired", "nonsense"]) {
      assert.ok(
        !PUNISHMENT_TYPES.some((t) => t.toLowerCase() === fake),
        `"${fake}" is not a real endpoint and must never be requested`,
      );
    }
  });
});
