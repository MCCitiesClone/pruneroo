import { getEnv } from "@/lib/env";
import {
  atRiskChannel,
  pruneChannel,
  punishmentsChannel,
} from "@/lib/notify/channels";
import { runNotifyChannel, type NotifyChannel } from "@/lib/notify/dispatch";

import { startRun } from "../queue";

/**
 * Discord alert jobs.
 *
 * Queued like every other job so they are visible on `/sync`, retried with the
 * same backoff, and can never overlap with themselves. They make **no** upstream
 * crawl requests: each is a local query against views the app already maintains,
 * plus a POST to Discord through the shared throttle. That is why they are
 * allowed on a timer at all — the no-timer rule is about re-crawling someone
 * else's API, and nothing here re-reads one.
 *
 * A channel with no webhook configured finishes as `skipped`, so running with
 * one webhook set is a normal, quiet state rather than a stream of failures.
 */

const SOURCE = "notify";

async function run(
  kind: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  channel: NotifyChannel<any>,
): Promise<void> {
  const record = await startRun(SOURCE, kind);
  try {
    const result = await runNotifyChannel(channel, getEnv().DISCORD_MAX_ITEMS_PER_RUN);
    await record.finish({
      status: result.status === "skipped" ? "skipped" : "ok",
      // Only the Discord POSTs are outbound; a seed or an empty run makes none.
      requestsMade: result.messages,
      itemsUpserted: result.items || result.seeded,
      note: result.note,
    });
  } catch (error) {
    await record.finish({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function handleNotifyPunishments(): Promise<void> {
  await run("notify.punishments", punishmentsChannel());
}

export async function handleNotifyPrune(): Promise<void> {
  await run("notify.prune", pruneChannel());
}

export async function handleNotifyAtRisk(): Promise<void> {
  await run("notify.atRisk", atRiskChannel());
}
