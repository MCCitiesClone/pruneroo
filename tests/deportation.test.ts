import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isDeportationActive,
  parseDeportation,
} from "../src/lib/sources/punishments/deportation";

/**
 * Deportations encode their lifecycle in free text, on a WARN that is usually
 * INFINITE. Reading only the record's `end` marks every completed deportation
 * as permanently in force — the defect these cases pin down.
 *
 * Every string here is copied verbatim from live data.
 */
describe("deportation reason parsing", () => {
  it("treats a Completed marker as no longer deported (IgnitedTnT)", () => {
    const reason =
      "Deportation: Respect - Low Effort Troll (Expiry: None) - Completed 2025-11-10 12:34:51";
    const info = parseDeportation(reason);
    assert.equal(info.isDeportation, true);
    assert.equal(info.completedAt?.toISOString(), "2025-11-10T12:34:51.000Z");
    assert.equal(info.expiresAt, null, "'Expiry: None' means indefinite");
    assert.equal(isDeportationActive(info), false);
  });

  it("keeps an indefinite, uncompleted deportation active", () => {
    const info = parseDeportation(
      "Deportation: Fair Play - Alternative Account (Expiry: None)",
    );
    assert.equal(info.completedAt, null);
    assert.equal(info.expiresAt, null);
    assert.equal(isDeportationActive(info), true);
  });

  it("reads the ISO expiry form and expires on it", () => {
    const info = parseDeportation(
      "Deportation: 1. Respect - Controversial Topics (Expiry: 2026-05-05 00:04:43)",
    );
    assert.equal(info.expiresAt?.toISOString(), "2026-05-05T00:04:43.000Z");
    assert.equal(isDeportationActive(info, new Date("2026-05-04T00:00:00Z")), true);
    assert.equal(isDeportationActive(info, new Date("2026-06-01T00:00:00Z")), false);
  });

  it("reads the legacy day/month/year expiry form", () => {
    const info = parseDeportation(
      "Deportation: 3.2 - Racism (B:2) Expiry: 07/10/2023",
    );
    // 07/10/2023 is 7 October, not 10 July.
    assert.equal(info.expiresAt?.toISOString(), "2023-10-07T00:00:00.000Z");
    assert.equal(isDeportationActive(info, new Date("2023-09-01T00:00:00Z")), true);
    assert.equal(isDeportationActive(info, new Date("2023-11-01T00:00:00Z")), false);
  });

  it("completion wins even when an expiry is still in the future", () => {
    const info = parseDeportation(
      "Deportation: X (Expiry: 2030-01-01 00:00:00) - Completed 2026-01-01 09:00:00",
    );
    assert.equal(isDeportationActive(info, new Date("2026-06-01T00:00:00Z")), false);
  });

  it("tolerates a Completed stamp without seconds", () => {
    const info = parseDeportation("Deportation: X - Completed 2026-08-19 11:58");
    assert.equal(info.completedAt?.toISOString(), "2026-08-19T11:58:00.000Z");
  });

  it("treats a blank Expiry as indefinite, not as expired", () => {
    // 15 live records look like this — the field was simply left empty.
    const info = parseDeportation("Deportation: 3.2 Racism (M:1) Expiry:");
    assert.equal(info.isDeportation, true);
    assert.equal(info.expiresAt, null);
    assert.equal(
      isDeportationActive(info),
      true,
      "an empty field is not evidence the deportation ended",
    );
  });

  it("ignores non-deportation reasons entirely", () => {
    const info = parseDeportation("1. Respect - Controversial Topics");
    assert.equal(info.isDeportation, false);
    assert.equal(isDeportationActive(info), false);
  });
});
