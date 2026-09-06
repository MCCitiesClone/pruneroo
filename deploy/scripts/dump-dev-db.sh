#!/usr/bin/env bash
#
# Dump the local dev database for transfer to production. Run on the dev
# machine, with `docker compose up -d db` running.
#
#   ./deploy/scripts/dump-dev-db.sh                 # -> pruneroo-<timestamp>.dump
#   ./deploy/scripts/dump-dev-db.sh /tmp/out.dump
#
# The dump is a full one: schema, data, views and the __drizzle_migrations
# table. Restoring it into an empty production database leaves nothing for
# `npm run db:migrate` to do, which is the point — the seeded-notification rows
# come across too, so production does not re-announce thousands of stored bans
# the first time a Discord webhook is set.
set -euo pipefail

CONTAINER="${DEV_DB_CONTAINER:-pruneroo-db}"
OUT="${1:-pruneroo-$(date -u +%Y%m%dT%H%M%SZ).dump}"

args=(
  --username=pruneroo
  --dbname=pruneroo
  --format=custom
  --compress=9
  --no-owner
  --no-privileges
)

# api_requests is a rolling audit log: the only reader (getSourceHealth) looks
# at the last hour. ~166k rows of history that production would never read.
# INCLUDE_REQUEST_LOG=1 keeps it.
if [ "${INCLUDE_REQUEST_LOG:-0}" != "1" ]; then
  args+=(--exclude-table-data=api_requests)
fi

echo "[dump] pg_dump from container ${CONTAINER} -> ${OUT}"
docker exec "$CONTAINER" pg_dump "${args[@]}" > "$OUT"

echo "[dump] $(du -h "$OUT" | cut -f1) written"
echo "[dump] next: scp \"$OUT\" your-node:/tmp/ && ssh your-node 'bash restore-prod-db.sh /tmp/$(basename "$OUT")'"
