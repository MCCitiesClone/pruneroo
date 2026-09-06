/**
 * Parsing a XenForo forum thread listing.
 *
 * The RSS feed looked like the obvious source but is a dead end: it is hard
 * capped at 100 items and ignores every pagination parameter
 * (`?page=2`, `/page-2/index.rss`, `_xfPage`) — all return the identical first
 * page. With 2 pages of open reports and 83 of archive, RSS could only ever see
 * the newest ~1% of the archive.
 *
 * The HTML listing paginates properly and, unlike RSS, carries the **thread
 * prefix** — the status label (`Pending`, `Solved`, `Auction Required`) that
 * decides whether a report is still live. RSS omits it entirely.
 *
 * Parsing HTML is more brittle than a feed, so this deliberately anchors on
 * XenForo's structural class names rather than layout, and the caller treats a
 * page that yields zero threads as an error rather than as "the end".
 */

export interface ListingThread {
  threadId: string;
  title: string;
  /** Status label shown on the listing, e.g. "Pending". Null when unprefixed. */
  prefix: string | null;
  url: string;
  author: string | null;
  postedAt: Date | null;
}

/** Each thread row is a `structItem--thread` block. */
const THREAD_SPLIT = /<div class="structItem structItem--thread/g;

const THREAD_ID = /js-threadListItem-(\d+)/;
const AUTHOR = /data-author="([^"]*)"/;
/** The prefix is a label anchored to a `prefix_id` filter link. */
const PREFIX = /prefix_id=\d+"[^>]*>\s*<span class="label[^"]*"[^>]*>([^<]*)<\/span>/;
/**
 * The title lives inside its own `structItem-title` block. Scoping to that
 * block first is essential: the row also contains a `/threads/...` anchor in
 * the start-date cell wrapping a `<time>` element, and a looser pattern happily
 * matched *that* — 237 reports were stored with a title of
 * `<time class="u-dt" ...` and matched no region at all.
 */
const TITLE_BLOCK = /<div class="structItem-title"[^>]*>([\s\S]*?)<\/div>/;
/**
 * Within the title block, the only thread anchor is the title itself.
 *
 * The trailing path segment is optional and deliberately captured separately:
 * XenForo links a thread you have not fully read as `/threads/slug.123/unread`,
 * and requiring the href to end at the id silently dropped 53 of every 100
 * rows. The stored url is normalised back to the canonical form, since
 * `/unread` resolves per-viewer rather than to a stable anchor.
 */
const TITLE_LINK =
  /<a href="\/threads\/([^"]*?)\.(\d+)\/(?:[^"]*)"[^>]*>([\s\S]*?)<\/a>/;
const START_TIMESTAMP =
  /structItem-startDate[\s\S]{0,400}?data-timestamp="(\d+)"/;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#039;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Shared with the single-thread parser in `thread.ts`, which reads the same
 * XenForo title markup off a thread page.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&[a-z]+;|&#039;/gi, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
}

/** How many thread rows the markup contains, parsed or not. */
export function countThreadRows(html: string): number {
  return html.split(THREAD_SPLIT).length - 1;
}

export function parseListing(
  html: string,
  origin: string,
): ListingThread[] {
  const chunks = html.split(THREAD_SPLIT).slice(1);

  return chunks.flatMap((chunk): ListingThread[] => {
    // Only look at the row itself, not whatever follows it.
    const row = chunk.slice(0, 6000);

    const titleBlock = TITLE_BLOCK.exec(row)?.[1];
    if (!titleBlock) return [];

    const link = TITLE_LINK.exec(titleBlock);
    if (!link) return [];

    // Prefer the id XenForo puts on the container; fall back to the URL slug.
    const threadId = THREAD_ID.exec(row)?.[1] ?? link[2];
    const title = decodeEntities(link[3]);
    // A title still containing markup means the block boundaries moved;
    // dropping it beats storing garbage that can never match a region.
    if (!threadId || !title || title.includes("<")) return [];

    const timestamp = START_TIMESTAMP.exec(row)?.[1];
    const prefixRaw = PREFIX.exec(titleBlock)?.[1];
    const prefix = prefixRaw ? decodeEntities(prefixRaw) : null;

    return [
      {
        threadId,
        title,
        // A stray `&nbsp;` label renders as an empty prefix; treat it as none.
        prefix: prefix && prefix.length > 0 ? prefix : null,
        // Canonical thread url, never the per-viewer `/unread` variant.
        url: new URL(`/threads/${link[1]}.${link[2]}/`, origin).toString(),
        author: AUTHOR.exec(row)?.[1] || null,
        postedAt: timestamp ? new Date(Number(timestamp) * 1000) : null,
      },
    ];
  });
}

/**
 * Highest page number linked from the pager, i.e. how many pages the listing
 * has. Returns 1 when the forum fits on a single page and shows no pager.
 */
export function parseLastPage(html: string): number {
  const pages = [...html.matchAll(/\/page-(\d+)\b/g)].map((m) => Number(m[1]));
  const max = pages.length > 0 ? Math.max(...pages) : 1;
  return Number.isFinite(max) && max > 0 ? max : 1;
}

/** Page 1 has no suffix; later pages are `/page-N`. */
export function listingPageUrl(baseUrl: string, page: number): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return page <= 1 ? `${trimmed}/` : `${trimmed}/page-${page}`;
}
