import type { DiscordMessage } from "./discord";
import type { NotifyChannelInfo } from "./channels";

/**
 * The message the `/sync` test button sends.
 *
 * Pure, and separate from the server action that sends it, so its shape can be
 * asserted in tests without a webhook or a request context.
 *
 * It has one job beyond proving the URL works: it must be unmistakable in a
 * channel that also carries real alerts. Hence the neutral colour — none of the
 * three alert colours — the explicit footer, and the "nothing was recorded"
 * wording, so nobody acts on it as if a player had just been banned.
 */
export function buildTestMessage(input: {
  info: NotifyChannelInfo;
  seeded: boolean;
  seededItems: number;
  appBaseUrl?: string;
  now: Date;
}): DiscordMessage {
  const { info, seeded, seededItems, appBaseUrl, now } = input;

  return {
    embeds: [
      {
        title: `Pruneroo test — ${info.label}`,
        description:
          "This is a test from the Sync page. Nothing was recorded and no " +
          "real alert was consumed.",
        url: appBaseUrl ? `${appBaseUrl}/sync` : undefined,
        color: 0x8a_8f_98,
        fields: [
          { name: "Channel", value: info.name, inline: true },
          { name: "Job", value: info.jobKind, inline: true },
          { name: "Fires on", value: info.description },
          {
            name: "Baseline",
            value: seeded
              ? `Recorded — ${seededItems.toLocaleString()} pre-existing item(s) marked known. Real alerts are live.`
              : "Not yet recorded. The next run marks existing items as known without announcing them.",
          },
        ],
        footer: { text: "Test message — not a real alert" },
        timestamp: now.toISOString(),
      },
    ],
  };
}
