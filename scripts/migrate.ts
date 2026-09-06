import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

/**
 * Runs the generated Drizzle migrations, then applies `views.sql`.
 *
 * The views live outside the migration chain deliberately: they are pure
 * derivations of the tables, so re-applying them with CREATE OR REPLACE on
 * every migrate is simpler and safer than versioning each edit.
 */
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  console.log("Applying migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });

  console.log("Applying views...");
  const views = readFileSync(
    join(process.cwd(), "src/lib/db/views.sql"),
    "utf8",
  );
  await db.execute(sql.raw(views));

  await pool.end();
  console.log("Done.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
