import "dotenv/config";

import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { parseDeportation } from "../src/lib/sources/punishments/deportation";

/**
 * Re-derive the parsed deportation columns from the `reason` text already
 * stored locally. Makes **zero** upstream requests.
 *
 * Whenever the parser in sources/punishments/deportation.ts changes, existing
 * rows hold values computed by the old logic. The obvious fix is a full
 * re-crawl, but that is ~1,900 requests to recompute something that is a pure
 * function of a column we already have — exactly the kind of pointless load
 * this project exists to avoid.
 *
 * Run after any parser change:  npm run reparse
 */
async function main() {
  const rows = await db.execute<{ id: string; reason: string }>(
    sql`SELECT id, reason FROM punishments WHERE reason ILIKE '%deportation%'`,
  );

  console.log(`Reparsing ${rows.rows.length} deportation records...`);

  let completed = 0;
  let expiring = 0;
  let changed = 0;

  const CHUNK = 500;
  for (let i = 0; i < rows.rows.length; i += CHUNK) {
    const batch = rows.rows.slice(i, i + CHUNK);

    // One statement per chunk via a VALUES join, rather than a round trip each.
    const values = sql.join(
      batch.map((row) => {
        const info = parseDeportation(row.reason);
        if (info.completedAt) completed += 1;
        if (info.expiresAt) expiring += 1;
        return sql`(${row.id}, ${info.completedAt}::timestamptz, ${info.expiresAt}::timestamptz)`;
      }),
      sql`, `,
    );

    const result = await db.execute(sql`
      UPDATE punishments p
         SET deportation_completed_at = v.completed_at,
             deportation_expires_at   = v.expires_at
        FROM (VALUES ${values}) AS v(id, completed_at, expires_at)
       WHERE p.id = v.id
         AND (p.deportation_completed_at IS DISTINCT FROM v.completed_at
              OR p.deportation_expires_at IS DISTINCT FROM v.expires_at)
    `);
    changed += result.rowCount ?? 0;
  }

  console.log(`  completed markers : ${completed}`);
  console.log(`  expiry dates      : ${expiring}`);
  console.log(`  rows updated      : ${changed}`);
  console.log("Done — no upstream requests made.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
