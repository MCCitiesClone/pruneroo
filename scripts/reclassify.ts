import "dotenv/config";

import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { classifyPlot } from "../src/lib/plots/categories";

/**
 * Re-derive every plot's zoning category from its id. Makes **zero** upstream
 * requests: the category is a pure function of `wg_region_id`, which is already
 * stored, so re-crawling 7,900 regions to recompute it would be pointless load.
 *
 * Run after any change to lib/plots/categories.ts.
 */
async function main() {
  const rows = await db.execute<{
    world_uuid: string;
    wg_region_id: string;
    tags: string[] | null;
  }>(sql`SELECT world_uuid, wg_region_id, tags FROM regions`);
  console.log(`Reclassifying ${rows.rows.length} plots...`);

  const counts = new Map<string, number>();
  let changed = 0;
  const CHUNK = 500;

  for (let i = 0; i < rows.rows.length; i += CHUNK) {
    const batch = rows.rows.slice(i, i + CHUNK);
    const values = sql.join(
      batch.map((row) => {
        const c = classifyPlot(String(row.wg_region_id), row.tags ?? []);
        const key = `${c.category}${c.area ? ` @${c.area}` : ""} [${c.source}]`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return sql`(${row.world_uuid}::uuid, ${row.wg_region_id}, ${c.category}, ${c.area}, ${c.source})`;
      }),
      sql`, `,
    );
    const result = await db.execute(sql`
      UPDATE regions r
         SET category = v.category, area = v.area, category_source = v.source
        FROM (VALUES ${values}) AS v(world_uuid, wg_region_id, category, area, source)
       WHERE r.world_uuid = v.world_uuid AND r.wg_region_id = v.wg_region_id
         AND (r.category IS DISTINCT FROM v.category
              OR r.area IS DISTINCT FROM v.area
              OR r.category_source IS DISTINCT FROM v.source)
    `);
    changed += result.rowCount ?? 0;
  }

  for (const [category, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${category.padEnd(14)} ${n}`);
  }
  console.log(`Updated ${changed} rows — no upstream requests made.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
