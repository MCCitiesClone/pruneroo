"use client";

import { useActionState } from "react";

import { sendTestNotification, type TestWebhookResult } from "./actions";

/**
 * Fire a test message at one Discord channel.
 *
 * Per channel rather than one global button: the three webhooks are configured
 * independently and usually point at different rooms, so "did it work" is a
 * question about one of them at a time. The result is shown in place — a
 * webhook that was deleted on Discord's side fails with a 404 that is worth
 * reading rather than swallowing.
 */
export function TestWebhookButton({
  channel,
  disabled,
}: {
  channel: string;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(
    async (): Promise<TestWebhookResult> => sendTestNotification(channel),
    null as TestWebhookResult | null,
  );

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <button
        type="submit"
        disabled={disabled || pending}
        title={
          disabled
            ? "No webhook URL configured for this channel"
            : "Sends a test message. Records nothing and consumes no real alert."
        }
        className="rounded border border-border-subtle px-2 py-1 text-xs whitespace-nowrap transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "sending…" : "Send test"}
      </button>
      {state ? (
        <span
          className={`text-right text-[10px] ${
            state.ok ? "text-ok" : "text-danger"
          }`}
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
