import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Side-effect import: must precede any module that validates env at load.
import "./_env";

import {
  clamp,
  clampMessage,
  formatDecimal,
  retryAfterMs,
} from "../src/lib/notify/discord";
import {
  atRiskReasons,
  groupByPlayer,
  isNotifyChannelName,
  NOTIFY_CHANNELS,
} from "../src/lib/notify/channels";
import { buildTestMessage } from "../src/lib/notify/test-message";
import { HANDLERS } from "../src/lib/sync/handlers";
import { SCHEDULE } from "../src/lib/sync/scheduler";

describe("discord payload limits", () => {
  it("keeps at most ten embeds, Discord's hard cap", () => {
    const message = clampMessage({
      embeds: Array.from({ length: 25 }, (_, i) => ({ title: `e${i}` })),
    });
    assert.equal(message.embeds!.length, 10);
  });

  it("truncates over-long titles and field values rather than 400ing", () => {
    // Ban reasons are free text from upstream; one pathological reason should
    // degrade the message, not fail it into a permanent retry loop.
    const message = clampMessage({
      embeds: [
        {
          title: "t".repeat(500),
          fields: [{ name: "n".repeat(400), value: "v".repeat(2000) }],
        },
      ],
    });
    const embed = message.embeds![0];
    assert.equal(embed.title!.length, 256);
    assert.equal(embed.fields![0].name.length, 256);
    assert.equal(embed.fields![0].value.length, 1024);
    assert.ok(embed.title!.endsWith("…"));
  });

  it("drops whole embeds to stay under the 6000-character budget", () => {
    // The budget is shared across the payload, so it can only be applied once
    // every embed is assembled.
    const big = { title: "x".repeat(250), description: "d".repeat(3000) };
    const message = clampMessage({ embeds: [big, big, big, big] });
    assert.ok(message.embeds!.length < 4, "some embeds dropped");
    assert.ok(message.embeds!.length >= 1, "never drops the last one");
  });

  it("never drops the only embed, however long", () => {
    const message = clampMessage({
      embeds: [{ description: "d".repeat(9000) }],
    });
    assert.equal(message.embeds!.length, 1);
    assert.equal(message.embeds![0].description!.length, 4096);
  });
});

describe("discord retry_after", () => {
  it("reads retry_after as seconds, not milliseconds", () => {
    // Discord reports seconds, often fractionally. Reading 0.75 as 0.75ms
    // would produce a retry loop against a limit that is still in force.
    assert.equal(retryAfterMs({ retry_after: 0.75 }), 750);
    assert.equal(retryAfterMs({ retry_after: 3 }), 3000);
  });

  it("falls back to the header, then to a real cooldown", () => {
    assert.equal(retryAfterMs({}, "2"), 2000);
    assert.equal(retryAfterMs(null, null), 5000);
    assert.equal(retryAfterMs({ retry_after: "nonsense" }, null), 5000);
    // A zero or negative value must still produce a wait.
    assert.equal(retryAfterMs({ retry_after: 0 }, null), 5000);
  });
});

describe("money formatting for alerts", () => {
  it("groups digits without going through Number", () => {
    assert.equal(formatDecimal("1234567.89"), "1,234,567.89");
    assert.equal(formatDecimal("10000"), "10,000");
    assert.equal(formatDecimal("999"), "999");
  });

  it("keeps exact digits a float would lose", () => {
    // The whole reason this is string-based: Number() rounds this value, and an
    // alert stating the wrong balance is worse than no alert.
    const exact = "9007199254740993.01";
    assert.equal(formatDecimal(exact), "9,007,199,254,740,993.01");
    assert.notEqual(String(Number(exact)), exact);
  });

  it("drops trailing zeros and handles negatives", () => {
    assert.equal(formatDecimal("1000.00"), "1,000");
    assert.equal(formatDecimal("1000.50"), "1,000.5");
    assert.equal(formatDecimal("-2500.25"), "-2,500.25");
  });

  it("passes through anything that is not a decimal", () => {
    assert.equal(formatDecimal("not a number"), "not a number");
  });

  it("clamps to a length with an ellipsis", () => {
    assert.equal(clamp("abcdef", 10), "abcdef");
    assert.equal(clamp("abcdef", 3), "ab…");
  });
});

describe("at-risk grouping", () => {
  const plot = (region: string, player: string, over = false) => ({
    entityKey: `w:${region}`,
    worldUuid: "w",
    worldName: "Reveille",
    wgRegionId: region,
    playerUuid: player,
    playerName: player,
    category: "commercial",
    contractType: "freehold",
    isBanned: true,
    isLongDeported: false,
    isOverLimit: over,
    playtime30dMs: 0,
    limitCount: over ? 23 : null,
    limitValue: over ? 20 : null,
  });

  it("batches every property of one holder into a single group", () => {
    // A banned player holding fourteen plots is one event, not fourteen.
    const groups = groupByPlayer([
      plot("c176", "bob"),
      plot("c177", "bob"),
      plot("r001", "alice"),
      plot("c178", "bob"),
    ]);
    assert.equal(groups.length, 2);
    const bob = groups.find((g) => g.playerUuid === "bob")!;
    assert.deepEqual(
      bob.properties.map((p) => p.wgRegionId),
      ["c176", "c177", "c178"],
    );
  });

  it("preserves the order holders first appear in", () => {
    const groups = groupByPlayer([plot("a", "x"), plot("b", "y"), plot("c", "x")]);
    assert.deepEqual(groups.map((g) => g.playerUuid), ["x", "y"]);
  });

  it("spells out why each plot is flagged", () => {
    const threshold = 6 * 3_600_000;
    assert.deepEqual(atRiskReasons(plot("c176", "bob"), threshold), ["banned"]);
    assert.deepEqual(
      atRiskReasons(plot("c176", "bob", true), threshold),
      ["banned", "over limit 23/20"],
    );
    // An unmeasured playtime is never reported as inactivity.
    assert.deepEqual(
      atRiskReasons(
        { ...plot("c176", "bob"), isBanned: false, playtime30dMs: null },
        threshold,
      ),
      [],
    );
  });
});

describe("test message", () => {
  const info = NOTIFY_CHANNELS.find((c) => c.name === "punishments")!;
  const now = new Date("2026-09-05T12:00:00Z");

  it("is unmistakably a test", () => {
    // It lands in the same room as real alerts, so nobody should be able to
    // act on it thinking a player was just banned.
    const embed = buildTestMessage({
      info,
      seeded: true,
      seededItems: 2858,
      now,
    }).embeds![0];
    assert.match(embed.title!, /test/i);
    assert.match(embed.description!, /Nothing was recorded/);
    assert.match(embed.footer!.text, /not a real alert/i);
  });

  it("uses a colour none of the real alerts use", () => {
    const embed = buildTestMessage({ info, seeded: true, seededItems: 0, now })
      .embeds![0];
    // The three alert colours, from channels.ts.
    assert.ok(![0xe04f5f, 0xe08c4f, 0x3ba55d, 0xe0b84f].includes(embed.color!));
  });

  it("reports whether the channel has a baseline yet", () => {
    // The most common cause of "my webhook is silent" is that the baseline pass
    // has not run, so the test says so rather than just claiming success.
    const seeded = buildTestMessage({ info, seeded: true, seededItems: 12, now })
      .embeds![0].fields!.find((f) => f.name === "Baseline")!;
    assert.match(seeded.value, /Recorded/);
    assert.match(seeded.value, /12/);

    const unseeded = buildTestMessage({ info, seeded: false, seededItems: 0, now })
      .embeds![0].fields!.find((f) => f.name === "Baseline")!;
    assert.match(unseeded.value, /Not yet recorded/);
  });

  it("links back only when the app url is known", () => {
    assert.equal(
      buildTestMessage({ info, seeded: true, seededItems: 0, now }).embeds![0].url,
      undefined,
    );
    assert.equal(
      buildTestMessage({
        info,
        seeded: true,
        seededItems: 0,
        appBaseUrl: "https://pruneroo.example",
        now,
      }).embeds![0].url,
      "https://pruneroo.example/sync",
    );
  });

  it("survives the payload clamp unchanged", () => {
    // A test that Discord rejects for being malformed would be worse than
    // useless, so it must already be within every limit.
    const message = buildTestMessage({ info, seeded: true, seededItems: 0, now });
    assert.deepEqual(clampMessage(message), {
      content: undefined,
      embeds: message.embeds,
    });
  });
});

describe("channel roster", () => {
  it("validates channel names, since one selects a webhook url", () => {
    // The name is the only thing that crosses from the browser; anything not on
    // the roster must be refused rather than used to look something up.
    assert.equal(isNotifyChannelName("punishments"), true);
    assert.equal(isNotifyChannelName("at-risk"), true);
    assert.equal(isNotifyChannelName("../../etc/passwd"), false);
    assert.equal(isNotifyChannelName(""), false);
  });

  it("gives every channel a job kind that a handler is registered for", () => {
    for (const channel of NOTIFY_CHANNELS) {
      assert.ok(HANDLERS[channel.jobKind], `no handler for ${channel.jobKind}`);
      assert.ok(
        SCHEDULE.some((entry) => entry.kind === channel.jobKind),
        `${channel.jobKind} is not scheduled`,
      );
    }
  });
});
