import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { toDate, toInt } from "@/lib/db/coerce";

import {
  NOTIFY_CHANNELS,
  notifyChannelByName,
  type NotifyChannelInfo,
} from "./channels";

/**
 * What each alert channel is currently doing, for the `/sync` panel.
 *
 * Three separate facts, all of which look the same from outside and mean very
 * different things when a channel is silent:
 *
 *   not configured  no webhook URL — nothing will ever be sent
 *   not seeded      configured, but the baseline pass has not run yet, so the
 *                   next run records history rather than announcing it
 *   seeded, quiet   working, and genuinely nothing new has happened
 *
 * Without this panel those are indistinguishable, and "my webhook is broken" is
 * usually the third one.
 */

export interface NotifyChannelStatus extends NotifyChannelInfo {
  configured: boolean;
  /** The baseline pass has run, so real alerts are live. */
  seeded: boolean;
  /** Things announced for real. */
  sent: number;
  /** Things recorded as pre-existing when the channel was switched on. */
  seededItems: number;
  lastSentAt: Date | null;
}

export async function getNotifyStatus(): Promise<NotifyChannelStatus[]> {
  const [deliveries, watermarks] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      SELECT channel,
             count(*) FILTER (WHERE disposition = 'sent')   AS sent,
             count(*) FILTER (WHERE disposition = 'seeded') AS seeded_items,
             max(sent_at) FILTER (WHERE disposition = 'sent') AS last_sent_at
        FROM notification_deliveries
       GROUP BY channel
    `),
    db.execute<Record<string, unknown>>(sql`
      SELECT key, cursor_text
        FROM sync_watermarks
       WHERE source = 'notify' AND key LIKE 'seeded.%'
    `),
  ]);

  const byChannel = new Map(
    deliveries.rows.map((row) => [String(row.channel), row]),
  );
  const seeded = new Set(
    watermarks.rows
      .filter((row) => row.cursor_text === "complete")
      .map((row) => String(row.key).replace(/^seeded\./, "")),
  );

  return NOTIFY_CHANNELS.map((info) => {
    const row = byChannel.get(info.name);
    return {
      ...info,
      // Read through the channel itself so "configured" can never disagree with
      // what the notifier would actually do.
      configured: Boolean(notifyChannelByName(info.name).webhookUrl),
      seeded: seeded.has(info.name),
      sent: toInt(row?.sent),
      seededItems: toInt(row?.seeded_items),
      lastSentAt: toDate(row?.last_sent_at),
    };
  });
}
