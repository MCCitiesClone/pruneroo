#!/bin/bash
#
# Build step of the Pelican install, run by the egg's install script inside a
# node:24 container with the repo already checked out at /mnt/server.
#
# It lives in the repo rather than in the egg so it can be changed without
# re-importing the egg — the egg only knows how to clone and call this.
set -euo pipefail

cd /mnt/server

echo "[install] node $(node -v), npm $(npm -v)"

npm ci --no-audit --no-fund

# Every page is force-dynamic, so the build never touches the database. It does
# need the rest of the environment to validate (src/lib/env.ts), which Wings
# supplies from the egg variables.
npm run build

# Record what was built so the startup script does not rebuild on first boot.
mkdir -p .deploy-state
git rev-parse HEAD > .deploy-state/build
sha256sum package-lock.json | cut -d' ' -f1 > .deploy-state/deps

echo "[install] done"
