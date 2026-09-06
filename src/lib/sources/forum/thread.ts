/**
 * Parsing a single XenForo thread — its URL, and its page.
 *
 * The listing parser in `listing.ts` covers the crawl. This covers the other
 * direction: an inspector has just filed a report and pastes the link back, so
 * the app has to turn one URL into a stored report before any crawl has seen
 * it.
 *
 * Both halves are deliberately strict. A mislinked report *suppresses its plot
 * from the at-risk list*, so a typo that silently linked to nothing would hide
 * a property from review with no visible cause. Every field here either parses
 * or the caller is told why not.
 */

import { decodeEntities } from "./listing";

export interface ThreadRef {
  threadId: string;
  /** Canonical `/threads/<slug>.<id>/` form, whatever variant was pasted. */
  url: string;
}

export interface ThreadPage extends ThreadRef {
  title: string;
  /** Status label on the thread, e.g. "Pending". Null when unprefixed. */
  prefix: string | null;
}

/**
 * XenForo thread URLs come in more shapes than the canonical one, and an
 * inspector pastes whichever the browser gave them:
 *
 *   /threads/c176-sep-10-2026.26813/
 *   /threads/c176-sep-10-2026.26813/post-412216   ← linking a specific reply
 *   /threads/c176-sep-10-2026.26813/unread        ← per-viewer, never canonical
 *   /threads/26813/                               ← slugless, still resolves
 *
 * The id is the only part that identifies the thread; the slug is decoration
 * XenForo regenerates from the title.
 */
const THREAD_PATH = /^\/threads\/(?:(.+)\.)?(\d+)(?:\/.*)?$/;

/** `data-content-key="thread-26813"` on the page root. */
const CONTENT_KEY = /data-content-key="thread-(\d+)"/;
const CANONICAL = /<link rel="canonical" href="([^"]+)"/;
/**
 * The thread header. Same shape as a listing row's title block: zero or more
 * label spans (the prefix, then a spacer) followed by the title text.
 */
const TITLE_BLOCK = /<h1 class="p-title-value">([\s\S]*?)<\/h1>/;
const LABEL = /<span class="label[^"]*"[^>]*>([\s\S]*?)<\/span>/;
const LABEL_ALL = /<span class="label[^"]*"[^>]*>[\s\S]*?<\/span>/g;
const TAG = /<[^>]+>/g;

/**
 * Resolve pasted input to a thread on *this* forum.
 *
 * `origin` is the forum's own origin, and a URL pointing anywhere else is
 * rejected rather than stored: the point of the paste is to record where a
 * report lives, and a link to another site is not that. A bare id is accepted
 * because it is unambiguous and people do paste it.
 */
export function parseThreadUrl(
  input: string,
  origin: string,
): ThreadRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const canonical = (slug: string | undefined, id: string): ThreadRef => ({
    threadId: id,
    url: new URL(`/threads/${slug ? `${slug}.` : ""}${id}/`, origin).toString(),
  });

  if (/^\d+$/.test(trimmed)) return canonical(undefined, trimmed);

  let url: URL;
  try {
    // A pasted path with no host is still usable; anything else must parse as
    // an absolute URL or it is not a link at all.
    url = new URL(trimmed, trimmed.startsWith("/") ? origin : undefined);
  } catch {
    return null;
  }

  if (url.origin !== new URL(origin).origin) return null;

  const match = THREAD_PATH.exec(url.pathname);
  if (!match) return null;
  return canonical(match[1], match[2]);
}

/**
 * Read the thread id, title and prefix off a fetched thread page.
 *
 * Returns null when the page is not a thread view — a login interstitial or an
 * error page rather than the report that was expected.
 */
export function parseThreadPage(
  html: string,
  origin: string,
): ThreadPage | null {
  const threadId = CONTENT_KEY.exec(html)?.[1];
  if (!threadId) return null;

  const block = TITLE_BLOCK.exec(html)?.[1];
  if (!block) return null;

  const prefixRaw = LABEL.exec(block)?.[1];
  const prefix = prefixRaw ? decodeEntities(prefixRaw.replace(TAG, "")) : null;

  // Everything that is not a label span is the title.
  const title = decodeEntities(block.replace(LABEL_ALL, "").replace(TAG, ""));
  if (!title) return null;

  const canonical = CANONICAL.exec(html)?.[1];
  return {
    threadId,
    title,
    prefix: prefix && prefix.length > 0 ? prefix : null,
    url: canonical ?? new URL(`/threads/${threadId}/`, origin).toString(),
  };
}
