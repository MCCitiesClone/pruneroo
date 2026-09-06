import { getThrottle } from "@/lib/http/throttles";

/**
 * Posting to a Discord webhook.
 *
 * Discord is a third party like any other upstream here, so every request goes
 * through the shared `discord` throttle rather than a bare `fetch`. Two
 * notifiers posting to two webhooks still share one budget, which is the point:
 * the budget belongs to the host, not to the caller.
 */

/** Discord's hard caps on a webhook payload. Exceeding any of them is a 400. */
const LIMITS = {
  embedsPerMessage: 10,
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  fieldsPerEmbed: 25,
  /** Sum of every text field in a payload. */
  totalPerMessage: 6000,
} as const;

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  /** Decimal, not hex — Discord's own encoding. */
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
}

export class DiscordError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Discord rejected the payload itself; retrying it unchanged cannot help. */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "DiscordError";
  }
}

/** Cut to `max`, leaving an ellipsis rather than a silently truncated word. */
export function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Trim a message to Discord's limits.
 *
 * Applied on the way out rather than trusted from the callers: a player name, a
 * ban reason and a plot list are all free text from upstream, and one
 * pathologically long reason should degrade a message rather than fail it with
 * a 400 that then retries forever.
 */
export function clampMessage(message: DiscordMessage): DiscordMessage {
  const embeds = (message.embeds ?? [])
    .slice(0, LIMITS.embedsPerMessage)
    .map((embed) => ({
      ...embed,
      title: embed.title ? clamp(embed.title, LIMITS.title) : undefined,
      description: embed.description
        ? clamp(embed.description, LIMITS.description)
        : undefined,
      fields: embed.fields?.slice(0, LIMITS.fieldsPerEmbed).map((field) => ({
        ...field,
        name: clamp(field.name, LIMITS.fieldName),
        value: clamp(field.value, LIMITS.fieldValue),
      })),
    }));

  // The 6,000-character budget is shared across every embed in the payload, so
  // it can only be enforced once they are all assembled: drop whole embeds from
  // the end until the total fits, since a half-rendered embed is worse than a
  // shorter message that says how many were held back.
  const size = (embed: DiscordEmbed) =>
    JSON.stringify(embed).length;
  let total = embeds.reduce((sum, e) => sum + size(e), 0);
  const kept = [...embeds];
  while (kept.length > 1 && total > LIMITS.totalPerMessage) {
    total -= size(kept.pop()!);
  }

  return {
    content: message.content ? clamp(message.content, 2000) : undefined,
    embeds: kept,
  };
}

/**
 * `retry_after` from a 429 body, in milliseconds.
 *
 * Discord reports it in *seconds* and often fractionally (`0.75`). Reading it
 * as milliseconds — an easy mistake, since the header of the same name is in
 * milliseconds on some APIs — would turn a 750ms cooldown into a 750ms-too-short
 * one and produce a retry loop.
 */
export function retryAfterMs(body: unknown, headerValue?: string | null): number {
  const fromBody =
    body && typeof body === "object" && "retry_after" in body
      ? Number((body as { retry_after: unknown }).retry_after)
      : NaN;
  const seconds = Number.isFinite(fromBody)
    ? fromBody
    : Number(headerValue ?? NaN);
  // A missing or nonsense value still has to produce a real cooldown.
  return Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds * 1000)
    : 5_000;
}

/**
 * Deliver one message.
 *
 * Throws on failure so the queue's own retry/backoff handles it — this makes no
 * attempt to retry in-process. A 429 penalises the shared bucket first, so the
 * retry, whenever it comes, starts from a slowed bucket rather than immediately
 * breaching the limit again.
 */
export async function postWebhook(
  webhookUrl: string,
  message: DiscordMessage,
): Promise<void> {
  const payload = clampMessage(message);

  const release = await getThrottle("discord").acquire("default");
  let status: number;
  let text: string;
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    status = response.status;
    text = await response.text();

    if (status === 429) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* a non-JSON 429 still gets the fallback cooldown */
      }
      const waitMs = retryAfterMs(parsed, response.headers.get("retry-after"));
      getThrottle("discord").penalise("default", waitMs);
      throw new DiscordError(
        `Discord rate limited the webhook; cooling down ${waitMs}ms`,
        status,
        false,
      );
    }
  } finally {
    release();
  }

  if (status >= 200 && status < 300) return;

  // 4xx other than 429 means the payload or the URL is wrong. Retrying an
  // identical request cannot fix either, and a deleted webhook (404) would
  // otherwise be retried until the job died.
  const permanent = status >= 400 && status < 500;
  throw new DiscordError(
    `Discord webhook returned HTTP ${status}: ${clamp(text, 300)}`,
    status,
    permanent,
  );
}

/**
 * Group digits without going through `Number`.
 *
 * Balances are Postgres `numeric` and travel as exact decimal strings; parsing
 * one into a float to format it is the precision bug this project avoids
 * everywhere else, and an alert saying the wrong number is worse than no alert.
 */
export function formatDecimal(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const [, sign, whole, fraction] = match;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // Money is shown to two places, and trailing zeros are dropped so a whole
  // number does not read as suspiciously precise.
  const rounded = fraction ? fraction.slice(0, 2).replace(/0+$/, "") : "";
  return `${sign}${grouped}${rounded ? `.${rounded}` : ""}`;
}
