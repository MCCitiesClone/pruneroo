/**
 * Deduplicate a batch by its conflict key before an upsert.
 *
 * Postgres rejects `INSERT ... ON CONFLICT DO UPDATE` when one statement would
 * affect the same row twice:
 *
 *   ON CONFLICT DO UPDATE command cannot affect row a second time
 *
 * This is not hypothetical. A live Punishments page contained two records with
 * an identical (type, victim, start-second, reason) — so an identical synthetic
 * id — which failed the whole batch, failed the job, and sent the crawl back to
 * page 1 on every retry. Paginated crawls can also re-serve a row across a page
 * boundary when the underlying list shifts mid-crawl.
 *
 * Later entries win, matching the "most recently observed" semantics an upsert
 * would otherwise apply.
 *
 * The result is also **sorted by key**, which gives every batch upsert a
 * deterministic row-lock order. Two concurrent handlers touching overlapping
 * rows in different orders deadlock in Postgres; a shared ordering makes that
 * impossible. Observed for real between the Realty and Treasury crawls.
 */
export function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  if (rows.length < 2) return rows;
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row);
}
