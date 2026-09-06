<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Pruneroo: upstream API reality

`docs/sources/` holds the published OpenAPI specs. They are not all accurate.
`docs/probes/` holds what the live APIs actually returned (`npm run probe`).

Before writing code against an upstream API, check the probe output. The
Punishments service in particular differs substantially from its spec — see the
table in README.md and the notes on the `punishments` table in
`src/lib/db/schema.ts`.

Two traps in that service specifically:

- **An unrecognised type slug returns the ban list instead of 404.**
  `/punishments/active/1`, `/punishments/all/1` and `/punishments/nonsense/1`
  are byte-identical to `/punishments/ban/1`. A typo is undetectable at runtime.
  Only `ban`, `mute`, `warn`, `kick` are real.
- **There is no revoked flag, and `active` is hardcoded false.** A lifted ban
  reports `label: "Permanent"` forever. Never treat an unexpired ban as
  enforced without the login cross-check in `v_active_punishments`.

Three rules this codebase holds to:

1. **Never re-crawl on a timer.** Every expensive crawl is gated behind an O(1)
   change probe (`*.stats` job kinds). Anything time-derived (expiries, sliding
   windows) is computed locally from stored timestamps, never polled.
   The sole exception is `treasury.prune.sweep`, which is timer-driven because
   it is not a re-crawl: Treasury has no bulk balance endpoint and no per-account
   change signal, so it drains a finite backlog asking about each player exactly
   once. Do not "fix" it by adding a probe — there is nothing to probe. Its
   convergence depends on `treasury_account_misses`; without that negative cache
   it re-asks unresolvable players forever.
2. **Every outbound request goes through the shared throttle.** All rate
   limiting lives in `src/lib/http/throttles.ts`, keyed by host. Never call
   `fetch` directly against a third party — not for a probe, not for "just one
   request per run". Two clients for one host with separate buckets silently
   double the real rate.
3. **Never assume the type of a raw-SQL column.** `db.execute()` bypasses
   Drizzle's column mapping: `timestamptz` comes back as a string, and
   `numeric`/`bigint` as strings. Coerce with `src/lib/db/coerce.ts`.
