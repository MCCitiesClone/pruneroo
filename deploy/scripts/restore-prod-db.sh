#!/usr/bin/env bash
#
# Restore a dev dump into the production database. Run on the Wings host.
#
#   ./restore-prod-db.sh /tmp/pruneroo-20260906T101500Z.dump
#
# DESTRUCTIVE: it drops and recreates the `pruneroo` database.
#
# Stop the Pruneroo server in the panel first. The sync worker holds a session
# advisory lock and writes continuously; this script terminates any remaining
# connections rather than waiting, so a running worker would be killed
# mid-transaction and left with jobs marked `running` (recovered on next boot by
# reclaimAbandoned, but there is no reason to make it do that).
set -euo pipefail

DUMP="${1:?usage: restore-prod-db.sh <dump file>}"
CONTAINER="${PROD_DB_CONTAINER:-pruneroo-db}"
DB="${PROD_DB_NAME:-pruneroo}"
OWNER="${PROD_DB_OWNER:-pruneroo}"

[ -f "$DUMP" ] || { echo "no such dump: $DUMP" >&2; exit 1; }

psql_admin() {
  docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 --username="$OWNER" --dbname=postgres "$@"
}

# Same major version on both ends or pg_restore will refuse newer archives.
echo "[restore] target: $(docker exec "$CONTAINER" postgres --version)"

# ADVISORY_LOCK_KEY from src/lib/sync/lock.ts. A key below 2^32 lands in objid
# with classid 0. A failed query must not read as "no lock held" — this drops a
# database next.
if ! lock_holders="$(psql_admin -tAc "
  SELECT count(*) FROM pg_locks
   WHERE locktype = 'advisory' AND classid = 0 AND objid = 8314207")"; then
  echo "[restore] could not query ${CONTAINER} — is Postgres up?" >&2
  exit 1
fi
if [ "${lock_holders//[[:space:]]/}" != "0" ]; then
  echo "[restore] a sync worker still holds the advisory lock — stop the Pelican server first" >&2
  exit 1
fi

if [ "${FORCE:-0}" != "1" ]; then
  read -r -p "[restore] drop and recreate database '${DB}' on ${CONTAINER}? [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ] || { echo "aborted"; exit 1; }
fi

echo "[restore] terminating existing connections to ${DB}"
psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                WHERE datname = '${DB}' AND pid <> pg_backend_pid()" > /dev/null

echo "[restore] recreating ${DB}"
psql_admin -c "DROP DATABASE IF EXISTS ${DB}"
psql_admin -c "CREATE DATABASE ${DB} OWNER ${OWNER}"

# Copied in rather than piped: parallel restore needs a seekable archive, and
# pg_restore reading stdin cannot use --jobs.
echo "[restore] copying $(du -h "$DUMP" | cut -f1) into the container"
docker cp "$DUMP" "${CONTAINER}:/tmp/pruneroo-restore.dump"
trap 'docker exec "$CONTAINER" rm -f /tmp/pruneroo-restore.dump >/dev/null 2>&1 || true' EXIT

echo "[restore] restoring"
docker exec -i "$CONTAINER" pg_restore \
  --username="$OWNER" \
  --dbname="$DB" \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --jobs="${RESTORE_JOBS:-4}" \
  /tmp/pruneroo-restore.dump

# The dump carries no planner statistics, and the insight views join ~95k
# players against ~63k balances — without this the first page loads plan badly.
echo "[restore] ANALYZE"
docker exec -i "$CONTAINER" psql --username="$OWNER" --dbname="$DB" -c "ANALYZE" > /dev/null

docker exec -i "$CONTAINER" psql --username="$OWNER" --dbname="$DB" -c "
  SELECT c.relname,
         (xpath('/row/c/text()',
                query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname),
                             false, true, '')))[1]::text::bigint AS rows
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
   ORDER BY rows DESC LIMIT 10"

echo "[restore] done — start the Pruneroo server in the panel"
