import "dotenv/config";

import { getEnv } from "../src/lib/env";
import { resolveTreasuryScope } from "../src/lib/sources";
import { bootSyncWorker } from "../src/lib/sync/boot";
import { HANDLERS } from "../src/lib/sync/handlers";
import { runOnce } from "../src/lib/sync/worker";

/**
 * Drive the sync layer from the command line.
 *
 *   npm run sync -- --kind=punishments.stats --once
 *   npm run sync -- --list
 *   npm run sync -- --worker            # run the full loop in the foreground
 */

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    out[match[1]] = match[2] ?? true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    console.log("Job kinds:");
    for (const kind of Object.keys(HANDLERS)) console.log(`  ${kind}`);
    return;
  }

  if (getEnv().TREASURY_TOKEN) {
    await resolveTreasuryScope().catch(() => undefined);
  }

  if (args.worker) {
    // Goes through bootSyncWorker so the exclusive lock applies here too —
    // running this alongside `next dev` must not double the upstream rate.
    const worker = await bootSyncWorker({ force: true });
    if (!worker) {
      console.error(
        "Worker did not start: another process holds the lock (is `next dev` running?)",
      );
      process.exit(1);
    }
    console.log(`Worker ${worker.workerId} running. Ctrl-C to stop.`);
    return;
  }

  const kind = typeof args.kind === "string" ? args.kind : null;
  if (!kind) {
    console.error(
      "Usage: npm run sync -- --kind=<job.kind> --once\n" +
        "       npm run sync -- --list\n" +
        "       npm run sync -- --worker",
    );
    process.exit(1);
  }

  const payload = typeof args.payload === "string" ? JSON.parse(args.payload) : {};
  const startedAt = Date.now();
  console.log(`Running ${kind}...`);
  await runOnce(kind, payload);
  console.log(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
