/**
 * The in-game command an operator runs to prune a player.
 *
 * Kept in its own module, free of any database import, so the client component
 * that owns the copy button can use the same formatter the server renders with.
 * Pulling this from `prune.ts` would drag `@/lib/db` into the browser bundle.
 */

/**
 * Format a balance for the command.
 *
 * Money reaches here as an exact decimal string from Postgres `numeric` and is
 * never parsed into a JS number — `Number("192811.05")` is fine, but the same
 * round trip on a large balance is not, and the whole pipeline is built to keep
 * these exact. So this is string manipulation only.
 *
 * Trailing zeros are trimmed and the result padded back to two places, which is
 * lossless: `68296.0000` and `68296.00` are the same amount, and money reads as
 * money. Digits beyond the second place are **kept, never rounded**. Every
 * balance observed so far is exact to two places, but if upstream ever returns
 * genuine sub-cent precision, emitting a rounded amount would silently either
 * leave a residue in the account or overdraw it. Better an odd-looking command
 * than a wrong one.
 */
export function formatPruneAmount(balance: string): string {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(balance.trim());
  // Not a plain decimal — hand it back untouched rather than inventing a value.
  if (!match) return balance.trim();

  const [, sign, whole, fractionRaw = ""] = match;
  let fraction = fractionRaw.replace(/0+$/, "");
  while (fraction.length < 2) fraction += "0";

  return `${sign}${whole}.${fraction}`;
}

/**
 * Build `/prune <username> <amount>`.
 *
 * Returns null when the player has no known username: the command addresses
 * players by name, so substituting a UUID would produce something that looks
 * copyable and fails in-game. The UI shows nothing rather than offering it.
 */
export function formatPruneCommand(
  playerName: string | null,
  balance: string | null,
): string | null {
  if (!playerName || !balance) return null;
  return `/prune ${playerName} ${formatPruneAmount(balance)}`;
}
