import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizePunishment } from "../src/lib/sources/punishments/client";
import { classifyVictim, normalizeUuid } from "../src/lib/identity";

const base = {
  victimUuid: "f3e44db6-32da-4cf5-9f8a-5eeaba6fc15d",
  victimUsername: "wasupp48",
  operatorUuid: "00000000-0000-0000-0000-000000000000",
  operatorUsername: "Console",
  reason: "Deportation: Respect - Low Effort Troll (Expiry: None)",
  active: false,
  start: 1788474905,
  end: 0,
  label: "Permanent",
};

describe("punishment normalisation", () => {
  it("treats end=0 as permanent, not epoch 1969", () => {
    const result = normalizePunishment("MUTE", base);
    assert.equal(result.endAt, null);
    assert.equal(result.isPermanent, true);
  });

  it("treats Long.MAX_VALUE-in-seconds as permanent instead of overflowing Date", () => {
    // Observed on live ban records: 9223372036854775807 ms expressed as seconds.
    const result = normalizePunishment("BAN", { ...base, end: 9223372036854775 });
    assert.equal(result.endAt, null);
    assert.equal(result.isPermanent, true);
  });

  it("parses timestamps as epoch seconds, not milliseconds", () => {
    const result = normalizePunishment("MUTE", base);
    assert.equal(result.startAt?.toISOString(), "2026-09-03T22:35:05.000Z");
  });

  it("keeps a real expiry as a date", () => {
    const result = normalizePunishment("MUTE", { ...base, end: 1788511261 });
    assert.equal(result.isPermanent, false);
    assert.equal(result.endAt?.toISOString(), "2026-09-04T08:41:01.000Z");
  });

  it("derives a stable synthetic id, since upstream provides none", () => {
    const a = normalizePunishment("MUTE", base);
    const b = normalizePunishment("MUTE", { ...base, label: "changed" });
    assert.equal(a.id, b.id, "cosmetic changes must not change identity");

    const other = normalizePunishment("BAN", base);
    assert.notEqual(a.id, other.id, "type is part of identity");
  });

  it("classifies IP victims separately so they create no player rows", () => {
    const result = normalizePunishment("BAN", {
      ...base,
      victimUuid: "192.168.1.50",
    });
    assert.equal(result.victimKind, "ip");
    assert.equal(result.victimUuid, null);
    assert.equal(result.victimRaw, "192.168.1.50");
  });

  it("records the upstream active flag without relying on it", () => {
    // Live data has `active: false` on records whose label is "Active",
    // so the field is stored but never used to derive status.
    const result = normalizePunishment("MUTE", {
      ...base,
      active: false,
      label: "Active",
      end: 1788511261,
    });
    assert.equal(result.reportedActive, false);
    assert.equal(result.label, "Active");
    assert.ok(result.endAt !== null);
  });
});

describe("uuid normalisation", () => {
  it("accepts undashed uuids and lowercases them", () => {
    assert.equal(
      normalizeUuid("F3E44DB632DA4CF59F8A5EEABA6FC15D"),
      "f3e44db6-32da-4cf5-9f8a-5eeaba6fc15d",
    );
  });

  it("accepts Floodgate-style uuids with leading zeros", () => {
    assert.equal(
      normalizeUuid("00000000-0000-0000-0009-01fe156717fd"),
      "00000000-0000-0000-0009-01fe156717fd",
    );
  });

  it("rejects IP addresses and other non-uuids", () => {
    assert.equal(normalizeUuid("192.168.1.50"), null);
    assert.equal(normalizeUuid("not-a-uuid"), null);
    assert.equal(normalizeUuid(null), null);
  });

  it("classifies victims by shape", () => {
    assert.equal(classifyVictim("10.0.0.1").kind, "ip");
    assert.equal(classifyVictim(base.victimUuid).kind, "uuid");
  });
});
