import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Side-effect import: must precede any module that validates env at load.
import "./_env";

import {
  extractEvictionDate,
  extractRegionIds,
  isReportActive,
  splitTitlePrefix,
} from "../src/lib/sources/forum/parse";
import { contentDigest } from "../src/lib/sources/forum/client";
import {
  countThreadRows,
  listingPageUrl,
  parseLastPage,
  parseListing,
} from "../src/lib/sources/forum/listing";
import {
  parseThreadPage,
  parseThreadUrl,
} from "../src/lib/sources/forum/thread";

/** The real id shapes present in the Realty data. */
const KNOWN = new Set([
  "c176",
  "c177",
  "c178",
  "c001",
  "av-c031",
  "av-c032",
  "432office-1",
  "1a",
  "1",
  "3",
]);

const RESOLVED = ["resolved", "accepted", "denied", "completed", "closed"];

describe("region extraction from report titles", () => {
  it("matches a single region", () => {
    assert.deepEqual(
      extractRegionIds("Eviction Report - c176", KNOWN).map((m) => m.wgRegionId),
      ["c176"],
    );
  });

  it("matches several regions in one report (the c176/c177 case)", () => {
    assert.deepEqual(
      extractRegionIds("Eviction Report - c176/c177", KNOWN).map((m) => m.wgRegionId),
      ["c176", "c177"],
    );
  });

  it("expands slash shorthand by borrowing the preceding prefix", () => {
    const ids = extractRegionIds("c176/177", KNOWN).map((m) => m.wgRegionId);
    assert.deepEqual(ids, ["c176", "c177"]);
    assert.equal(
      extractRegionIds("c176/177", KNOWN)[1].via,
      "slash-shorthand",
      "provenance is recorded so a surprising match can be audited",
    );
  });

  it("never invents a region from shorthand", () => {
    // c999 does not exist, so the shorthand simply fails to resolve.
    assert.deepEqual(
      extractRegionIds("c176/999", KNOWN).map((m) => m.wgRegionId),
      ["c176"],
    );
  });

  it("keeps hyphenated ids intact", () => {
    assert.deepEqual(
      extractRegionIds("Eviction: av-c031 and 432office-1", KNOWN).map(
        (m) => m.wgRegionId,
      ),
      ["av-c031", "432office-1"],
    );
  });

  it("ignores bare integers so dates and counts do not match plots", () => {
    // "1" and "3" are real region ids, but matching them here would be noise.
    assert.deepEqual(
      extractRegionIds("3 eviction reports filed on 1 May", KNOWN),
      [],
    );
  });

  it("is case-insensitive and deduplicates repeats", () => {
    assert.deepEqual(
      extractRegionIds("C176 and c176 (C176)", KNOWN).map((m) => m.wgRegionId),
      ["c176"],
    );
  });

  it("returns nothing when no known region is named", () => {
    assert.deepEqual(extractRegionIds("General eviction policy discussion", KNOWN), []);
  });

  it("handles comma and 'and' separated lists", () => {
    assert.deepEqual(
      extractRegionIds("Eviction Report: c176, c177 and c178", KNOWN).map(
        (m) => m.wgRegionId,
      ),
      ["c176", "c177", "c178"],
    );
  });
});

describe("report prefix and active state", () => {
  it("reads a bracketed prefix", () => {
    assert.deepEqual(splitTitlePrefix("[Pending] Eviction Report - c176"), {
      prefix: "pending",
      rest: "Eviction Report - c176",
    });
  });

  it("reads a colon-delimited prefix", () => {
    assert.deepEqual(splitTitlePrefix("Resolved: c176"), {
      prefix: "resolved",
      rest: "c176",
    });
  });

  it("does not mistake an unprefixed subject for a prefix", () => {
    // A bare leading word must stay part of the title, or real reports vanish.
    assert.deepEqual(splitTitlePrefix("Eviction Report c176"), {
      prefix: null,
      rest: "Eviction Report c176",
    });
  });

  it("treats a resolved prefix as inactive", () => {
    for (const p of RESOLVED) assert.equal(isReportActive(p, RESOLVED), false);
  });

  it("treats pending and unprefixed reports as active", () => {
    assert.equal(isReportActive("pending", RESOLVED), true);
    assert.equal(isReportActive(null, RESOLVED), true);
  });

  it("defaults an unknown prefix to active", () => {
    // Safer direction: a new in-progress state must not silently un-suppress a
    // plot that is still being handled.
    assert.equal(isReportActive("under review", RESOLVED), true);
  });

  it("handles compound prefixes containing a resolved word", () => {
    assert.equal(isReportActive("resolved - accepted", RESOLVED), false);
  });
});

describe("forum listing parsing", () => {
  /**
   * Markup copied from the live eviction-reports listing. RSS was abandoned as
   * a source: it caps at 100 items, ignores pagination, and — critically —
   * omits the thread prefix that this markup carries.
   */
  const html = `<div class="structItemContainer-group js-threadList">
  <div class="structItem structItem--thread is-prefix5 js-inlineModContainer js-threadListItem-43727" data-author="edwardcul1en">
    <div class="structItem-cell structItem-cell--main">
      <div class="structItem-title">
        <a href="/forums/eviction-reports.62/?prefix_id=5" class="labelLink" rel="nofollow"><span class="label white" dir="auto">Pending</span></a>
        <a href="/threads/c176-c177-sep-10-2026.43727/" class="" data-tp-primary="on"> c176/c177 | Sep 10, 2026 </a>
      </div>
      <div class="structItem-minor"><ul class="structItem-parts">
        <li class="structItem-startDate"><a href="/threads/x.43727/"><time class="u-dt" datetime="2026-09-03T22:51:32-0400" data-timestamp="1788490292">Yesterday</time></a></li>
      </ul></div>
    </div>
  </div>
  <div class="structItem structItem--thread js-threadListItem-43700" data-author="someone">
    <div class="structItem-title">
      <a href="/threads/c178-sep-1-2026.43700/" data-tp-primary="on"> c178 | Sep 1, 2026 </a>
    </div>
    <div class="structItem-minor"><li class="structItem-startDate"><time data-timestamp="1788000000">x</time></li></div>
  </div>
</div>
<nav class="pageNavWrapper"><ul class="pageNav-main">
  <li class="pageNav-page"><a href="/forums/eviction-reports.62/">1</a></li>
  <li class="pageNav-page"><a href="/forums/eviction-reports.62/page-2">2</a></li>
</ul></nav>`;

  it("extracts thread id, title, prefix and author", () => {
    const [first] = parseListing(html, "https://forum.example");
    assert.equal(first.threadId, "43727");
    assert.equal(first.title, "c176/c177 | Sep 10, 2026");
    assert.equal(first.prefix, "Pending");
    assert.equal(first.author, "edwardcul1en");
    assert.equal(
      first.url,
      "https://forum.example/threads/c176-c177-sep-10-2026.43727/",
    );
    assert.equal(first.postedAt?.toISOString(), "2026-09-04T02:51:32.000Z");
  });

  it("reads a thread with no prefix as unprefixed rather than skipping it", () => {
    const threads = parseListing(html, "https://forum.example");
    assert.equal(threads.length, 2);
    assert.equal(threads[1].threadId, "43700");
    assert.equal(threads[1].prefix, null);
  });

  it("does not mistake the prefix filter link for the thread link", () => {
    const [first] = parseListing(html, "https://forum.example");
    assert.ok(
      !first.url.includes("prefix_id"),
      "the label link must not be taken as the thread url",
    );
  });

  it("reads the last page number from the pager", () => {
    assert.equal(parseLastPage(html), 2);
    assert.equal(parseLastPage("<div>no pager here</div>"), 1);
  });

  it("builds page urls the way XenForo does", () => {
    const base = "https://forum.example/forums/archive.158/";
    assert.equal(listingPageUrl(base, 1), "https://forum.example/forums/archive.158/");
    assert.equal(listingPageUrl(base, 7), "https://forum.example/forums/archive.158/page-7");
  });

  it("returns nothing for markup with no thread rows", () => {
    // The client treats this as an error rather than "the forum is empty".
    assert.deepEqual(parseListing("<html><body>nope</body></html>", "https://x"), []);
  });
});

describe("canonical region casing", () => {
  /**
   * 1,338 of 7,874 real region ids are mixed-case (`Billboard1`, `C-StaffTrg`).
   * Matching is case-insensitive, but the id written to the link table must
   * keep the database's own casing — storing the lowercased match token joined
   * back to nothing, so reports on those regions silently did nothing.
   */
  const MIXED = new Map([
    ["billboard1", "Billboard1"],
    ["c-stafftrg", "C-StaffTrg"],
    ["c176", "c176"],
  ]);
  const ids = new Set(MIXED.keys());

  it("matches mixed-case ids regardless of how the title spells them", () => {
    for (const spelling of ["Billboard1", "billboard1", "BILLBOARD1"]) {
      assert.deepEqual(
        extractRegionIds(`Eviction Report - ${spelling}`, ids).map(
          (m) => m.wgRegionId,
        ),
        ["billboard1"],
        `${spelling} should match`,
      );
    }
  });

  it("resolves every match back to a canonical id", () => {
    const matches = extractRegionIds("Report: Billboard1 and C-StaffTrg", ids);
    const canonical = matches.map((m) => MIXED.get(m.wgRegionId));
    assert.deepEqual(canonical, ["Billboard1", "C-StaffTrg"]);
    assert.ok(
      canonical.every((id) => id !== undefined),
      "a match must always resolve to a stored region id",
    );
  });
});

describe("eviction date in the title", () => {
  /**
   * Every one of the 100 live reports is titled `<regions> | <Mon DD, YYYY>`
   * and none carries a thread prefix, so this date is the only per-report state
   * the feed actually exposes.
   */
  it("reads the date from a real title", () => {
    assert.equal(
      extractEvictionDate("c176/c177 | Sep 10, 2026")?.toISOString(),
      "2026-09-10T00:00:00.000Z",
    );
  });

  it("handles every month abbreviation seen in the feed", () => {
    assert.equal(
      extractEvictionDate("c001 | Jul 9, 2026")?.toISOString(),
      "2026-07-09T00:00:00.000Z",
    );
    assert.equal(
      extractEvictionDate("c002 | Aug 31, 2026")?.toISOString(),
      "2026-08-31T00:00:00.000Z",
    );
  });

  it("tolerates a missing comma and a full month name", () => {
    assert.equal(
      extractEvictionDate("c003 | September 1 2026")?.toISOString(),
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("returns null when the title states no date", () => {
    assert.equal(extractEvictionDate("c176/c177"), null);
    assert.equal(extractEvictionDate("Eviction policy discussion"), null);
  });

  it("does not confuse the date with a region id", () => {
    // The date must not leak into region matching, and vice versa.
    const ids = new Set(["c176", "c177"]);
    assert.deepEqual(
      extractRegionIds("c176/c177 | Sep 10, 2026", ids).map((m) => m.wgRegionId),
      ["c176", "c177"],
    );
  });
});

describe("archived reports", () => {
  /**
   * Threads are moved to the archive forum once dealt with, which is the only
   * resolution signal the feeds provide — no live title carries a prefix. An
   * archived report is history: it belongs on the region page but must never
   * suppress the plot from review.
   */
  it("is archived regardless of what its title says", () => {
    // Even a title that would otherwise read as active.
    const { prefix } = splitTitlePrefix("wl-f139 | Aug 26, 2026");
    assert.equal(prefix, null);
    assert.equal(
      isReportActive(prefix, RESOLVED),
      true,
      "the open forum would call this active…",
    );
    // …but the archive pass overrides that, so the stored state is inactive.
    const archived = true;
    assert.equal(archived ? false : isReportActive(prefix, RESOLVED), false);
  });

  it("parses archive titles the same way as open ones", () => {
    const ids = new Set(["wl-f139", "r064"]);
    assert.deepEqual(
      extractRegionIds("wl-f139 | Aug 26, 2026", ids).map((m) => m.wgRegionId),
      ["wl-f139"],
    );
    assert.equal(
      extractEvictionDate("wl-f139 | Aug 26, 2026")?.toISOString(),
      "2026-08-26T00:00:00.000Z",
    );
  });

  it("handles the uppercase ids the archive contains", () => {
    // The archive includes "R064 | July 2, 2026" — uppercase, full month name.
    const ids = new Set(["r064"]);
    assert.deepEqual(
      extractRegionIds("R064 | July 2, 2026", ids).map((m) => m.wgRegionId),
      ["r064"],
    );
    assert.equal(
      extractEvictionDate("R064 | July 2, 2026")?.toISOString(),
      "2026-07-02T00:00:00.000Z",
    );
  });

  it("handles a report naming many regions at once", () => {
    // One live archive thread names fourteen plots.
    const ids = new Set(Array.from({ length: 14 }, (_, i) => `c${100 + i}`));
    const title = [...ids].join("/") + " | Aug 12, 2026";
    assert.equal(extractRegionIds(title, ids).length, 14);
  });
});

describe("feed change detection", () => {
  /**
   * XenForo stamps the channel `<pubDate>` with the current time, so the raw
   * XML differs on every request and a body hash never matches — the sync
   * re-wrote every report each run. The fingerprint therefore covers only the
   * fields that carry meaning.
   */
  const item = (threadId: string, title: string, posted: string) => ({
    threadId,
    title,
    prefix: "Pending",
    url: `https://forum/t/${threadId}`,
    author: "someone",
    postedAt: new Date(posted),
  });

  const a = item("1", "c176 | Sep 10, 2026", "2026-09-01T00:00:00Z");
  const b = item("2", "c177 | Sep 11, 2026", "2026-09-02T00:00:00Z");

  it("is stable across identical fetches", () => {
    assert.equal(contentDigest([a, b]), contentDigest([a, b]));
  });

  it("ignores item ordering", () => {
    assert.equal(contentDigest([a, b]), contentDigest([b, a]));
  });

  it("ignores fields that carry no meaning for us", () => {
    const sameButDifferentAuthor = { ...a, author: "someone-else" };
    assert.equal(contentDigest([a]), contentDigest([sameButDifferentAuthor]));
  });

  it("changes when a prefix changes, since that is the status signal", () => {
    assert.notEqual(contentDigest([a]), contentDigest([{ ...a, prefix: "Solved" }]));
  });

  it("changes when a title changes", () => {
    assert.notEqual(
      contentDigest([a]),
      contentDigest([{ ...a, title: "c176/c177 | Sep 10, 2026" }]),
    );
  });

  it("changes when a thread is added or removed", () => {
    assert.notEqual(contentDigest([a]), contentDigest([a, b]));
  });
});

describe("title extraction is scoped to the title block", () => {
  /**
   * A thread row contains two `/threads/...` anchors: the title, and the
   * start-date link wrapping a `<time>` element. An unscoped pattern matched
   * the date one, storing 237 reports with a title of `<time class="u-dt" ...`
   * that could never match a plot.
   */
  const row = `<div class="structItem structItem--thread js-threadListItem-99" data-author="x">
    <div class="structItem-cell structItem-cell--main">
      <div class="structItem-title">
        <a href="/threads/c999-sep-1-2026.99/"> C999 | Sep 1, 2026 </a>
      </div>
      <div class="structItem-minor"><ul class="structItem-parts">
        <li class="structItem-startDate">
          <a href="/threads/c999-sep-1-2026.99/"><time class="u-dt" data-timestamp="1788000000">Yesterday</time></a>
        </li>
      </ul></div>
    </div>
  </div>`;

  it("takes the title, not the date anchor", () => {
    const [thread] = parseListing(row, "https://f.example");
    assert.equal(thread.title, "C999 | Sep 1, 2026");
    assert.ok(!thread.title.includes("<time"), "must not capture markup");
  });

  it("drops a row whose title still contains markup", () => {
    // Belt and braces: if the block boundaries ever move again, storing
    // garbage that can never match a plot is worse than skipping the row.
    const broken = row.replace(
      "<a href=\"/threads/c999-sep-1-2026.99/\"> C999 | Sep 1, 2026 </a>",
      "<a href=\"/threads/c999-sep-1-2026.99/\"><time class=\"u-dt\">x</time></a>",
    );
    assert.deepEqual(parseListing(broken, "https://f.example"), []);
  });
});

describe("case-insensitive plot matching", () => {
  it("matches an uppercase report title to a lowercase plot", () => {
    // "The C999 eviction report should go to the c999 plot."
    const known = new Set(["c999"]);
    assert.deepEqual(
      extractRegionIds("C999 | Sep 1, 2026", known).map((m) => m.wgRegionId),
      ["c999"],
    );
  });

  it("matches every casing of a multi-plot title", () => {
    const known = new Set(["c743", "c742", "c741"]);
    assert.deepEqual(
      extractRegionIds("C743/C742/c741 | Aug 1, 2026", known).map(
        (m) => m.wgRegionId,
      ),
      ["c743", "c742", "c741"],
    );
  });
});

describe("unread thread links", () => {
  /**
   * XenForo links a thread you have not fully read as `/threads/slug.123/unread`.
   * Requiring the href to end at the id dropped 53 of every 100 rows — and
   * silently, because the page still parsed *some* threads. Hence both the
   * relaxed pattern and the coverage check in the client.
   */
  const row = (href: string) => `<div class="structItem structItem--thread js-threadListItem-40846" data-author="poker">
    <div class="structItem-title">
      <a href="/forums/eviction-reports.62/?prefix_id=131" class="labelLink"><span class="label label--skyBlue">Auctioning</span></a>
      <a href="${href}" data-tp-primary="on"> r042 | Jul 19, 2026 </a>
    </div>
    <div class="structItem-minor"><li class="structItem-startDate"><time data-timestamp="1788000000">x</time></li></div>
  </div>`;

  it("parses a thread linked as /unread", () => {
    const [t] = parseListing(row("/threads/r042-jul-19-2026.40846/unread"), "https://f.example");
    assert.equal(t.threadId, "40846");
    assert.equal(t.title, "r042 | Jul 19, 2026");
    assert.equal(t.prefix, "Auctioning");
  });

  it("normalises /unread to the canonical thread url", () => {
    const [t] = parseListing(row("/threads/r042-jul-19-2026.40846/unread"), "https://f.example");
    assert.equal(
      t.url,
      "https://f.example/threads/r042-jul-19-2026.40846/",
      "/unread resolves per-viewer, so it must not be stored",
    );
  });

  it("parses the plain form identically", () => {
    const plain = parseListing(row("/threads/r042-jul-19-2026.40846/"), "https://f.example");
    const unread = parseListing(row("/threads/r042-jul-19-2026.40846/unread"), "https://f.example");
    assert.deepEqual(plain, unread);
  });

  it("counts thread rows independently of whether they parse", () => {
    // This is what lets the client notice a *partial* parse failure.
    const two = row("/threads/a.1/") + row("/threads/b.2/unread");
    assert.equal(countThreadRows(two), 2);
    assert.equal(parseListing(two, "https://f.example").length, 2);
  });
});

describe("thread url parsing", () => {
  const ORIGIN = "https://www.democracycraft.net";
  const canonical = `${ORIGIN}/threads/c176-sep-10-2026.26813/`;

  it("accepts the canonical thread url", () => {
    const ref = parseThreadUrl(canonical, ORIGIN);
    assert.equal(ref?.threadId, "26813");
    assert.equal(ref?.url, canonical);
  });

  it("normalises the variants a browser actually gives you", () => {
    // A reply permalink, an unread link and a bare path all identify the same
    // thread; only the id matters and the slug is XenForo's decoration.
    for (const input of [
      `${ORIGIN}/threads/c176-sep-10-2026.26813/post-412216`,
      `${ORIGIN}/threads/c176-sep-10-2026.26813/unread`,
      `${ORIGIN}/threads/c176-sep-10-2026.26813`,
      "/threads/c176-sep-10-2026.26813/",
    ]) {
      const ref = parseThreadUrl(input, ORIGIN);
      assert.equal(ref?.threadId, "26813", input);
      assert.equal(ref?.url, canonical, input);
    }
  });

  it("accepts a slugless url and a bare thread id", () => {
    assert.equal(parseThreadUrl(`${ORIGIN}/threads/26813/`, ORIGIN)?.threadId, "26813");
    assert.equal(parseThreadUrl("26813", ORIGIN)?.threadId, "26813");
  });

  it("refuses a link to any other site", () => {
    // A mislinked report suppresses its plot from the at-risk list, so a URL
    // that is not this forum is rejected rather than stored.
    assert.equal(
      parseThreadUrl("https://evil.example/threads/c176.26813/", ORIGIN),
      null,
    );
  });

  it("refuses forum urls that are not threads", () => {
    for (const input of [
      `${ORIGIN}/forums/eviction-reports.62/`,
      `${ORIGIN}/members/someone.11495/`,
      `${ORIGIN}/threads/no-id-here/`,
      "not a url at all",
      "",
    ]) {
      assert.equal(parseThreadUrl(input, ORIGIN), null, input);
    }
  });
});

describe("thread page parsing", () => {
  const ORIGIN = "https://www.democracycraft.net";

  /** The same markup XenForo renders for a thread header. */
  const page = (opts: { id: string; prefix?: string; title: string }) => `
    <html id="XF" data-content-key="thread-${opts.id}">
    <head><link rel="canonical" href="${ORIGIN}/threads/slug.${opts.id}/" /></head>
    <body><h1 class="p-title-value">${
      opts.prefix
        ? `<span class="label label--royalBlue" dir="auto">${opts.prefix}</span><span class="label-append">&nbsp;</span>`
        : ""
    }${opts.title}</h1></body></html>`;

  it("reads the id, prefix and title off a thread page", () => {
    const parsed = parseThreadPage(
      page({ id: "26813", prefix: "Pending", title: "c176/c177 | Sep 10, 2026" }),
      ORIGIN,
    );
    assert.equal(parsed?.threadId, "26813");
    assert.equal(parsed?.prefix, "Pending");
    assert.equal(parsed?.title, "c176/c177 | Sep 10, 2026");
    assert.equal(parsed?.url, `${ORIGIN}/threads/slug.26813/`);
  });

  it("reads an unprefixed thread as having no prefix", () => {
    const parsed = parseThreadPage(page({ id: "42", title: "c001 | Jul 2, 2026" }), ORIGIN);
    assert.equal(parsed?.prefix, null);
    assert.equal(parsed?.title, "c001 | Jul 2, 2026");
  });

  it("decodes entities in the title", () => {
    const parsed = parseThreadPage(
      page({ id: "7", title: "a1 &amp; a2 | Sep 4, 2026" }),
      ORIGIN,
    );
    assert.equal(parsed?.title, "a1 & a2 | Sep 4, 2026");
  });

  it("returns null for a page that is not a thread view", () => {
    // A login interstitial is the realistic case: it is a 200 with no thread on
    // it, and treating that as a report would attach the plot to nothing.
    assert.equal(parseThreadPage("<html><body>Log in</body></html>", ORIGIN), null);
    assert.equal(
      parseThreadPage('<html data-content-key="thread-1"></html>', ORIGIN),
      null,
      "an id with no title block is not enough",
    );
  });

  it("parses a real archived thread page", () => {
    // docs/policy/ holds genuine XenForo thread_view captures, so the parser is
    // checked against markup nobody here wrote.
    const html = readFileSync(
      new URL("../docs/policy/evictions-policy.2026-06-17.html", import.meta.url),
      "utf8",
    );
    const parsed = parseThreadPage(html, ORIGIN);
    assert.equal(parsed?.threadId, "26813");
    assert.equal(parsed?.title, "Evictions Policy");
    assert.equal(parsed?.prefix, "Policy");
    assert.equal(parsed?.url, `${ORIGIN}/threads/evictions-policy.26813/`);
  });
});
