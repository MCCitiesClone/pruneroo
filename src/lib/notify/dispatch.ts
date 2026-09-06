import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { getWatermark, setWatermark } from "@/lib/sync/queue";

import { DiscordError, postWebhook, type DiscordMessage } from "./discord";

/**
 * The shared half of every Discord notifier: work out what is new, send it, and
 * remember that it was sent.
 *
 * Each channel supplies only the parts that differ — which rows qualify and how
 * they read as a message. Everything below is identical across the three and is
 * where the properties that matter live:
 *
 * **Nothing is announced twice.** A delivery is recorded per message, straight
 * after that message succeeds. A channel that fails halfway keeps what it
 * already sent and retries only the rest, because the queue re-runs the job.
 *
 * **Enabling a webhook is not an event.** The first run of a newly configured
 * channel records everything that already qualifies *without sending it*. There
 * are thousands of stored bans and at-risk plots; announcing them because
 * someone pasted a webhook URL would bury the one alert that mattered. The
 * baseline is per channel, so adding a second webhook later does not re-seed
 * the first.
 *
 * **A burst is bounded, not dropped.** `maxItems` caps one run; the remainder
 * is picked up by the next. This matters most for prune, where the balance
 * backfill can qualify thousands of players in an afternoon.
 */

const SOURCE = "notify";

export interface NotifyBatch {
  message: DiscordMessage;
  /** The entity keys this message covers, recorded once it is delivered. */
  keys: string[];
}

export interface NotifyChannel<T> {
  /** Stable name, also the `notification_deliveries.channel` value. */
  channel: string;
  /** Unset means the channel is switched off; the job skips rather than fails. */
  webhookUrl: string | undefined;
  /** `SELECT entity_key ...` for everything that qualifies right now. */
  seedQuery(): SQL;
  /** Qualifying things not yet delivered, most interesting first. */
  findNew(limit: number): Promise<T[]>;
  /** Render into messages, each carrying the keys it accounts for. */
  build(items: T[]): NotifyBatch[];
}

export interface NotifyResult {
  status: "skipped" | "seeded" | "ok";
  /** Things announced, and messages it took. */
  items: number;
  messages: number;
  seeded: number;
  note: string;
}

function seededKey(channel: string): string {
  return `seeded.${channel}`;
}

/**
 * Record the baseline for a channel: everything qualifying today, marked as
 * seeded rather than sent.
 *
 * Done as one `INSERT ... SELECT` rather than by reading keys into memory —
 * at-risk seeds thousands of rows, and there is no reason for any of them to
 * make the round trip.
 */
async function seed(ch: NotifyChannel<unknown>): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO notification_deliveries (channel, entity_key, disposition)
    SELECT ${ch.channel}, k.entity_key, 'seeded'
      FROM (${ch.seedQuery()}) AS k
    ON CONFLICT (channel, entity_key) DO NOTHING
  `);
  await setWatermark(SOURCE, seededKey(ch.channel), { cursorText: "complete" });
  return result.rowCount ?? 0;
}

async function record(channel: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.execute(sql`
    INSERT INTO notification_deliveries (channel, entity_key, disposition)
    VALUES ${sql.join(
      keys.map((key) => sql`(${channel}, ${key}, 'sent')`),
      sql`, `,
    )}
    ON CONFLICT (channel, entity_key) DO NOTHING
  `);
}

export async function runNotifyChannel<T>(
  ch: NotifyChannel<T>,
  maxItems: number,
): Promise<NotifyResult> {
  if (!ch.webhookUrl) {
    return {
      status: "skipped",
      items: 0,
      messages: 0,
      seeded: 0,
      note: `No webhook configured for ${ch.channel}.`,
    };
  }

  const alreadySeeded =
    (await getWatermark(SOURCE, seededKey(ch.channel)))?.cursorText === "complete";

  if (!alreadySeeded) {
    const seeded = await seed(ch as NotifyChannel<unknown>);
    return {
      status: "seeded",
      items: 0,
      messages: 0,
      seeded,
      note:
        `Baseline recorded for ${ch.channel}: ${seeded} existing item(s) marked ` +
        "as already known and not announced. Alerts start from the next new one.",
    };
  }

  const items = await ch.findNew(maxItems);
  if (items.length === 0) {
    return {
      status: "ok",
      items: 0,
      messages: 0,
      seeded: 0,
      note: `Nothing new for ${ch.channel}.`,
    };
  }

  const batches = ch.build(items);
  let sent = 0;
  let announced = 0;

  for (const batch of batches) {
    try {
      await postWebhook(ch.webhookUrl, batch.message);
    } catch (error) {
      // A payload Discord will never accept must not wedge the channel: record
      // the keys so the run moves on, and let the error surface on /sync.
      if (error instanceof DiscordError && error.permanent) {
        await record(ch.channel, batch.keys);
      }
      if (sent > 0) {
        // Some of this run landed. Report what got through rather than losing
        // it in a stack trace; the rest is still un-recorded and retries.
        throw new Error(
          `${ch.channel}: sent ${sent} message(s), then failed — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      throw error;
    }
    await record(ch.channel, batch.keys);
    sent += 1;
    announced += batch.keys.length;
  }

  return {
    status: "ok",
    items: announced,
    messages: sent,
    seeded: 0,
    note: `${ch.channel}: announced ${announced} item(s) in ${sent} message(s).`,
  };
}
