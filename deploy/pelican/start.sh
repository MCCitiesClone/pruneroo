#!/bin/bash
#
# Pelican startup command for Pruneroo.
#
# Wings runs this inside the Node yolk image with /home/container as the server
# root, and passes every egg variable through as an environment variable — the
# app reads them straight out of process.env, so there is no .env file here.
#
# Signals: the yolk entrypoint `eval`s the startup command in its own shell, so
# the final `exec` is what matters. It puts the Next server on the process that
# receives the panel's Stop (SIGINT under `tini -g`), which is what lets
# bootSyncWorker's handler drain the queue and release the advisory lock instead
# of the container being killed with jobs still marked `running`.
set -euo pipefail

cd /home/container

# Wings sets this from the server allocation; a clear message beats the bare
# "unbound variable" from set -u. (No apostrophes in the message: a quote inside
# ${...:?} starts a new quoting context even within double quotes.)
: "${SERVER_PORT:?set by Wings from the server allocation}"

AUTO_UPDATE="${AUTO_UPDATE:-1}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-1}"
GIT_BRANCH="${GIT_BRANCH:-main}"
STATE_DIR=".deploy-state"

mkdir -p "$STATE_DIR"

log() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }

if [ "$AUTO_UPDATE" = "1" ] && [ -d .git ]; then
  log "fetching origin/${GIT_BRANCH}"
  git fetch --prune origin "$GIT_BRANCH"
  git reset --hard "origin/${GIT_BRANCH}"
fi

rev="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
lock="$(sha256sum package-lock.json | cut -d' ' -f1)"

# Dev dependencies are not optional: next build needs typescript, tailwind and
# the React compiler plugin, and db:migrate runs through tsx.
if [ ! -d node_modules ] || [ "$(cat "$STATE_DIR/deps" 2>/dev/null || true)" != "$lock" ]; then
  log "installing dependencies (package-lock changed or node_modules missing)"
  npm ci --no-audit --no-fund
  printf '%s\n' "$lock" > "$STATE_DIR/deps"
  rm -f "$STATE_DIR/build"
fi

# next build is the memory-hungry step. Wings enforces the server's memory limit
# as a cgroup limit, and V8 does not read it — left alone, the heap grows past
# the limit and the container is OOM-killed (exit 137) mid-build.
if [[ "${SERVER_MEMORY:-0}" =~ ^[0-9]+$ ]] && [ "${SERVER_MEMORY:-0}" -gt 1024 ]; then
  export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=$(( SERVER_MEMORY * 3 / 4 ))"
fi

if [ ! -f .next/BUILD_ID ] || [ "$(cat "$STATE_DIR/build" 2>/dev/null || true)" != "$rev" ]; then
  log "building ${rev}"
  npm run build
  printf '%s\n' "$rev" > "$STATE_DIR/build"
else
  log "build up to date (${rev})"
fi

# Migrations are idempotent and views.sql is re-applied with CREATE OR REPLACE
# on every run, so this is safe on every boot. The retry is for the ordinary
# case of the app container starting before Postgres finishes recovery.
if [ "$RUN_MIGRATIONS" = "1" ]; then
  for attempt in 1 2 3 4 5; do
    if npm run --silent db:migrate; then
      break
    fi
    if [ "$attempt" = 5 ]; then
      log "database still unreachable after 5 attempts — check DATABASE_URL"
      exit 1
    fi
    log "database not ready, retrying in 5s (${attempt}/5)"
    sleep 5
  done
fi

log "starting Next on 0.0.0.0:${SERVER_PORT}"
exec node_modules/.bin/next start --hostname 0.0.0.0 --port "${SERVER_PORT}"
