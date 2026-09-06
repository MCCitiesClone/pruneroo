/**
 * Parsing deportation state out of the free-text `reason`.
 *
 * A deportation is recorded as an ordinary WARN or MUTE whose reason encodes
 * the real lifecycle. The underlying punishment is frequently INFINITE, so the
 * record's own `end` says nothing — the reason is the only source of truth:
 *
 *   Deportation: <rule> (Expiry: None)
 *   Deportation: <rule> (Expiry: 2026-08-28 11:14:07)
 *   Deportation: <rule> Expiry: 07/10/2023                  (legacy form)
 *   Deportation: <rule> (Expiry: None) - Completed 2025-11-10 12:34:51
 *
 * "Completed" means the player served the deportation and is no longer
 * deported, even though the WARN itself never expires. Without reading it, a
 * completed deportation stays flagged forever.
 *
 * Timestamps in these strings carry no timezone. They are read as UTC, matching
 * every other timestamp this API emits.
 *
 * A blank `Expiry:` with no value (15 live records) is treated as indefinite
 * rather than expired — a staff member left the field empty, which is not
 * evidence the deportation ended. That errs toward keeping the player visible.
 */

/** `- Completed 2025-11-10 12:34:51` (seconds sometimes omitted). */
const COMPLETED =
  /completed\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/i;

/** `(Expiry: 2026-08-28 11:14:07)` */
const EXPIRY_ISO =
  /expiry:\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/i;

/** `Expiry: 07/10/2023` — day/month/year, the legacy form. */
const EXPIRY_DMY = /expiry:\s*(\d{2})\/(\d{2})\/(\d{4})/i;

function utc(date: string, time: string): Date | null {
  const normalized = time.length === 5 ? `${time}:00` : time;
  const parsed = new Date(`${date}T${normalized}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface DeportationInfo {
  isDeportation: boolean;
  /** When the player finished serving it; null if still outstanding. */
  completedAt: Date | null;
  /** Scheduled end, if the reason states one. Null means indefinite. */
  expiresAt: Date | null;
}

export function parseDeportation(reason: string): DeportationInfo {
  const isDeportation = /deportation/i.test(reason);
  if (!isDeportation) {
    return { isDeportation: false, completedAt: null, expiresAt: null };
  }

  const completed = COMPLETED.exec(reason);
  const completedAt = completed ? utc(completed[1], completed[2]) : null;

  let expiresAt: Date | null = null;
  const iso = EXPIRY_ISO.exec(reason);
  if (iso) {
    expiresAt = utc(iso[1], iso[2]);
  } else {
    const dmy = EXPIRY_DMY.exec(reason);
    if (dmy) {
      expiresAt = utc(`${dmy[3]}-${dmy[2]}-${dmy[1]}`, "00:00:00");
    }
  }

  return { isDeportation, completedAt, expiresAt };
}

/**
 * Whether a deportation is in force right now.
 *
 * Exported for tests; the dashboard evaluates the same logic in SQL
 * (`v_active_punishments`) so it stays correct as time passes without a resync.
 */
export function isDeportationActive(
  info: DeportationInfo,
  now: Date = new Date(),
): boolean {
  if (!info.isDeportation) return false;
  if (info.completedAt !== null) return false;
  if (info.expiresAt !== null && info.expiresAt <= now) return false;
  return true;
}
