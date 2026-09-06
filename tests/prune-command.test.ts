import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatPruneAmount,
  formatPruneCommand,
} from "../src/lib/insights/prune-command";

/**
 * The copied command moves real money in-game, so the amount in it must equal
 * the balance exactly. Rounding would either strand a residue in the account or
 * overdraw it, and neither is visible to whoever pastes the command.
 */
describe("prune command formatting", () => {
  it("keeps two decimal places for whole amounts", () => {
    assert.equal(formatPruneAmount("68296.00"), "68296.00");
    assert.equal(formatPruneAmount("500"), "500.00");
  });

  it("trims trailing zeros past two places, which is lossless", () => {
    // Postgres numeric round-trips at scale 4 for some balances; 68296.0000
    // and 68296.00 are the same amount.
    assert.equal(formatPruneAmount("68296.0000"), "68296.00");
    assert.equal(formatPruneAmount("1234.5600"), "1234.56");
    assert.equal(formatPruneAmount("1234.5000"), "1234.50");
  });

  it("never rounds away sub-cent precision", () => {
    // No balance observed upstream has these, but rounding one to 1234.57
    // would produce a command that does not match the account.
    assert.equal(formatPruneAmount("1234.5678"), "1234.5678");
    assert.equal(formatPruneAmount("0.0001"), "0.0001");
  });

  it("does not round-trip through a JS number", () => {
    // Beyond Number.MAX_SAFE_INTEGER: Number() would corrupt this silently.
    const huge = "9007199254740993.01";
    assert.equal(formatPruneAmount(huge), huge);
    assert.notEqual(String(Number(huge)), huge);
  });

  it("preserves the digits of a large balance exactly", () => {
    assert.equal(formatPruneAmount("192811.05"), "192811.05");
    assert.equal(formatPruneAmount("123456789012345678.90"), "123456789012345678.90");
  });

  it("passes through anything that is not a plain decimal", () => {
    // parseMoney stores the raw string when it fails validation, so a
    // surprising value must not be turned into an invented number.
    assert.equal(formatPruneAmount("1e5"), "1e5");
    assert.equal(formatPruneAmount("not money"), "not money");
  });

  it("builds the command in the documented format", () => {
    assert.equal(
      formatPruneCommand("WWW2020", "192811.05"),
      "/prune WWW2020 192811.05",
    );
  });

  it("declines to build a command without a username", () => {
    // /prune addresses players by name, so a UUID substitute would look
    // copyable and fail in-game.
    assert.equal(formatPruneCommand(null, "100.00"), null);
    assert.equal(formatPruneCommand("", "100.00"), null);
  });

  it("declines to build a command without a balance", () => {
    assert.equal(formatPruneCommand("WWW2020", null), null);
  });
});
