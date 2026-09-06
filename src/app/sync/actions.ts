"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { sourceHealth, syncJobs } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import {
  isNotifyChannelName,
  NOTIFY_CHANNELS,
  notifyChannelByName,
} from "@/lib/notify/channels";
import { DiscordError, postWebhook } from "@/lib/notify/discord";
import { getNotifyStatus } from "@/lib/notify/status";
import { buildTestMessage } from "@/lib/notify/test-message";
import { enqueue } from "@/lib/sync/queue";
import { enqueueAllProbes } from "@/lib/sync/scheduler";

/**
 * Queue every change probe immediately. Each is one or two requests; the
 * expensive crawls still only run if a probe finds something changed.
 */
export async function triggerAllProbes(): Promise<void> {
  await enqueueAllProbes();
  revalidatePath("/sync");
}

export async function triggerJob(kind: string): Promise<void> {
  await enqueue({
    source: kind.split(".")[0],
    kind,
    dedupeKey: kind,
    priority: 1,
  });
  revalidatePath("/sync");
}

/** Put dead jobs back in the queue after the underlying problem is fixed. */
export async function retryDeadJobs(): Promise<void> {
  await db
    .update(syncJobs)
    .set({
      status: "pending",
      attempts: 0,
      lastError: null,
      runAfter: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(syncJobs.status, "dead"));
  revalidatePath("/sync");
}

/** Close a source's circuit breaker early, once the upstream looks healthy. */
export async function resetCircuit(source: string): Promise<void> {
  await db
    .update(sourceHealth)
    .set({
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(sourceHealth.source, source));
  revalidatePath("/sync");
}


export interface TestWebhookResult {
  ok: boolean;
  message: string;
}

/**
 * Send a test message to one alert channel.
 *
 * Deliberately inert as far as the notifiers are concerned: it records no
 * delivery and does not seed the channel, so testing a webhook can never cause
 * a real alert to be skipped later. It is a check that the URL works and that
 * Discord accepts our payload shape, nothing more.
 *
 * The channel *name* is all that crosses from the browser, and it is validated
 * against the roster before use — the webhook URL is read from the environment
 * here. A URL passed in from the client would make this an open relay for
 * posting to arbitrary hosts.
 */
export async function sendTestNotification(
  channel: string,
): Promise<TestWebhookResult> {
  if (!isNotifyChannelName(channel)) {
    return { ok: false, message: `Unknown channel "${channel}".` };
  }

  const info = NOTIFY_CHANNELS.find((c) => c.name === channel)!;
  const webhookUrl = notifyChannelByName(channel).webhookUrl;
  if (!webhookUrl) {
    return { ok: false, message: `${info.envVar} is not set.` };
  }

  const status = (await getNotifyStatus()).find((s) => s.name === channel);
  const base = getEnv().APP_BASE_URL;

  try {
    await postWebhook(
      webhookUrl,
      buildTestMessage({
        info,
        seeded: status?.seeded ?? false,
        seededItems: status?.seededItems ?? 0,
        appBaseUrl: base,
        now: new Date(),
      }),
    );
  } catch (error) {
    if (error instanceof DiscordError) {
      return {
        ok: false,
        message: error.permanent
          ? `Discord rejected it (HTTP ${error.status}). Check the webhook URL still exists.`
          : error.message,
      };
    }
    // A bad hostname or a firewalled egress surfaces here, and the raw cause is
    // the useful part.
    return {
      ok: false,
      message: `Could not reach Discord: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  revalidatePath("/sync");
  return { ok: true, message: `Test sent to ${info.label}.` };
}
