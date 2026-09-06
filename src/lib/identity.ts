/**
 * Cross-API identity reconciliation.
 *
 * The Minecraft UUID is the only key shared by Realty, Analytics, Treasury and
 * Punishments, but each API states it differently: Realty declares
 * `format: uuid`, Treasury mostly declares a bare string, and Punishments'
 * `victim` may hold an IP address instead of a UUID entirely. Everything is
 * normalised here, once, on the way in.
 */

const DASHED =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNDASHED = /^[0-9a-f]{32}$/;

/**
 * Normalise to lowercase dashed form, accepting either dashed or undashed
 * 32-hex input. Returns null for anything that isn't a UUID — including IP
 * addresses, which would otherwise become phantom player rows.
 */
export function normalizeUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (DASHED.test(trimmed)) return trimmed;
  if (UNDASHED.test(trimmed)) {
    return [
      trimmed.slice(0, 8),
      trimmed.slice(8, 12),
      trimmed.slice(12, 16),
      trimmed.slice(16, 20),
      trimmed.slice(20),
    ].join("-");
  }
  return null;
}

export function isUuid(value: unknown): boolean {
  return normalizeUuid(value) !== null;
}

export type VictimKind = "uuid" | "ip";

/**
 * A LibertyBans `victim` is documented as "UUID or IP address". Anything that
 * doesn't parse as a UUID is treated as an IP-scoped punishment, which has no
 * player to attach to.
 */
export function classifyVictim(victim: string): {
  kind: VictimKind;
  uuid: string | null;
} {
  const uuid = normalizeUuid(victim);
  return uuid ? { kind: "uuid", uuid } : { kind: "ip", uuid: null };
}

/** The all-zero UUID is LibertyBans' "Console" operator, not a real player. */
export const CONSOLE_UUID = "00000000-0000-0000-0000-000000000000";

export function isConsole(uuid: string | null): boolean {
  return uuid === CONSOLE_UUID;
}

export function normalizeName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}
