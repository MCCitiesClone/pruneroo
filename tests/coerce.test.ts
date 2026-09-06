import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  toBool,
  toDate,
  toDecimalString,
  toInt,
  toNumber,
} from "../src/lib/db/coerce";

/**
 * Regression cover for the raw-SQL boundary.
 *
 * `db.execute()` bypasses Drizzle's column mapping, so its generic type is a
 * claim rather than a guarantee: Postgres `timestamptz` actually arrives as a
 * string, and `numeric`/`bigint` as strings too. Typing those columns as `Date`
 * type-checked fine and then threw "toISOString is not a function" at runtime.
 */
describe("raw-SQL coercion", () => {
  it("parses the timestamp string format the pg driver actually returns", () => {
    const date = toDate("2026-09-21 00:41:41+00");
    assert.ok(date instanceof Date);
    assert.equal(date?.toISOString(), "2026-09-21T00:41:41.000Z");
  });

  it("passes Date instances through unchanged", () => {
    const original = new Date("2026-01-01T00:00:00Z");
    assert.equal(toDate(original)?.getTime(), original.getTime());
  });

  it("returns null for unparseable values instead of an Invalid Date", () => {
    assert.equal(toDate(null), null);
    assert.equal(toDate(undefined), null);
    assert.equal(toDate("not a date"), null);
    assert.equal(toDate({}), null);
  });

  it("keeps decimals as exact strings so money never loses precision", () => {
    // A JS number cannot hold this exactly.
    const huge = "123456789012345678901234.5678";
    assert.equal(toDecimalString(huge), huge);
  });

  it("coerces bigint-as-string counts to numbers", () => {
    assert.equal(toNumber("21600000"), 21_600_000);
    assert.equal(toNumber(null), null);
    assert.equal(toInt(null), 0);
    assert.equal(toInt("42"), 42);
  });

  it("reads Postgres boolean representations", () => {
    assert.equal(toBool(true), true);
    assert.equal(toBool("t"), true);
    assert.equal(toBool("true"), true);
    assert.equal(toBool(false), false);
    assert.equal(toBool(null), false);
    assert.equal(toBool("f"), false);
  });
});
