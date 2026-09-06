# Deploying to a Pelican server

The whole application is one long-running Node process. `next start` serves the
dashboard and `src/instrumentation.ts` boots the sync worker inside the same
process, so a Pelican server — one container, one startup command, one stop
signal — is a good fit rather than an awkward one.

What Pelican does not provide is the database. The panel's own **Databases**
feature provisions MySQL/MariaDB, and this schema is Postgres to the bone:
`numeric` money, `timestamptz`, session advisory locks, and the views in
`src/lib/db/views.sql`. So Postgres runs beside Wings on the node with Docker
Compose, and the container reaches it over the Wings bridge network.

The finished shape:

```
                internet
                   │  443
              ┌────┴─────┐
              │  Caddy   │  TLS, on the host
              └────┬─────┘
                   │  127.0.0.1:<allocation>
        ┌──────────┴───────────┐
        │  Pelican server      │  ghcr.io/pelican-eggs/yolks:nodejs_24
        │  next start + worker │  /home/container = git checkout
        └──────────┬───────────┘
                   │  172.18.0.1:5432  (pelican_nw gateway)
        ┌──────────┴───────────┐
        │  postgres:17-alpine  │  docker compose, on the host
        └──────────────────────┘
```

Everything referenced below lives in `deploy/`.

## 0. Before you start

- Root/SSH on the Wings node, with Docker.
- A DNS A record pointing at the node.
- Credentials to hand: Treasury JWT, Analytics login, forum `xf_user` cookie,
  Discord webhooks. Same values as `.env`; see the table in the README.

## 1. Postgres on the host

```sh
scp -r deploy/postgres your-node:/opt/pruneroo-db
ssh your-node
cd /opt/pruneroo-db
cp .env.example .env && $EDITOR .env      # set POSTGRES_PASSWORD
```

Confirm the bridge address before bringing it up — the compose file binds
Postgres to that address and nothing else, so a wrong value means either an
unreachable database or one published to the world:

```sh
docker network inspect pelican_nw -f '{{(index .IPAM.Config 0).Gateway}}'   # expect 172.18.0.1
docker compose up -d
```

Then verify from inside the network the app will actually run in. Do this now;
it is the single most common reason a first boot fails, and the failure mode
from inside the container is a 90-second `ETIMEDOUT` per page rather than a
clear refusal:

```sh
docker run --rm --network pelican_nw postgres:17-alpine \
  psql "postgres://pruneroo:PASSWORD@172.18.0.1:5432/pruneroo" -c "select 1"
```

`shm_size: 512mb` is not decoration. Docker defaults `/dev/shm` to 64MB, which
the insight views exhaust as soon as a parallel query needs a shared hash table
(`could not resize shared memory segment`, SQLSTATE 53100).

## 2. Move the existing data across

The dev database already holds ~95k players, ~63k Treasury balances and the
eviction-report history. Do not re-crawl to rebuild it: the balance backfill
alone is ~122,000 requests against someone else's game server, and it is
rate-limited to about seven hours. Transfer it instead.

On the dev machine, with `docker compose up -d db` running:

```sh
./deploy/scripts/dump-dev-db.sh                 # -> pruneroo-<timestamp>.dump (~14MB)
scp pruneroo-*.dump your-node:/tmp/
```

On the node, with the Pelican server **stopped** (or before it is created):

```sh
scp deploy/scripts/restore-prod-db.sh your-node:/opt/pruneroo-db/
ssh your-node /opt/pruneroo-db/restore-prod-db.sh /tmp/pruneroo-<timestamp>.dump
```

What that moves, and why it matters:

- **The full schema, including the views and `drizzle.__drizzle_migrations`.**
  Production therefore starts already migrated, and the `db:migrate` on first
  boot is a no-op that only re-applies `views.sql` with `CREATE OR REPLACE`.
- **`notification_deliveries` and the `seeded.<channel>` watermarks.** This is
  the reason to transfer rather than start empty: a fresh database would treat
  every stored ban as unseen, and the first notifier run would seed thousands of
  items instead of announcing the next real one. See "Enabling a webhook is not
  an event" in the README.
- **`sync_jobs`, including the Treasury sweep backlog.** The backfill resumes
  where dev left it rather than starting over.
- **Not `api_requests`.** It is a rolling audit log and only the last hour is
  ever read (`getSourceHealth`), so ~166k rows of history are excluded from the
  dump. Pass `INCLUDE_REQUEST_LOG=1` to keep them.

The restore script refuses to run while anything holds the worker's advisory
lock (`ADVISORY_LOCK_KEY` in `src/lib/sync/lock.ts`), drops and recreates the
database, then runs `ANALYZE` — the dump carries no planner statistics, and the
insight views join ~95k players against ~63k balances.

Keep the major versions equal on both ends (17 here); `pg_restore` will not read
an archive from a newer server.

## 3. Import the egg and create the server

1. **Admin → Eggs → Import Egg** → `deploy/pelican/egg-pruneroo.json`.
   It is `PTDL_v2`, which is the format Pelican imports and the format the whole
   `pelican-eggs` library ships in.
2. **Create a server** on the Pruneroo egg:
   - **Docker image**: `ghcr.io/pelican-eggs/yolks:nodejs_24`
   - **Memory**: 3072MB or more. `next build` is the peak, not serving. Below
     ~2GB the build is OOM-killed by the cgroup limit and the install log ends
     at exit 137.
   - **Disk**: 5120MB or more (`node_modules` ≈ 700MB, `.next` ≈ 1GB, plus the
     git checkout).
   - **Allocation**: on `127.0.0.1`, so Wings publishes the port on loopback and
     the dashboard is reachable only through Caddy. It has no authentication of
     its own and it lists player balances and ban history.
   - **CPU**: leave unlimited if you can; the build is parallel.
3. **Fill in the variables** (§4). `GIT_ADDRESS` already points at the public
   repository; what actually needs filling is `DATABASE_URL`, `TREASURY_TOKEN`,
   the Analytics login and `FORUM_COOKIE`.

Installation clones the repo and runs `deploy/pelican/install.sh` — `npm ci`
then `next build` — in a `node:24-trixie-slim` container. Watch it in the
install log; it takes a few minutes on first run, most of it `npm ci`.

The build needs no database. Every page is `force-dynamic`, so nothing is
prerendered against Postgres; it does need the rest of the environment to
validate (`src/lib/env.ts`), which Wings supplies from the egg variables.

## 4. Variables behave differently in a panel than in a `.env` file

**A blank field is an empty string, not an unset variable.** Wings passes every
variable the egg defines, blank ones included. `.env` semantics are the
opposite — `src/lib/env.ts` goes out of its way to read a blank line as "not
configured" — and only the fields written for it (`optionalSecret`,
`numberOrDefault`) survive an empty string. The rest do not:
`INACTIVITY_THRESHOLD_HOURS=""` is `Number("") === 0`, silently, and a blank
`REALTY_BASE_URL` fails `z.url()` and the app will not boot.

So: the egg ships a real default for every non-secret variable, and those fields
should be edited, never cleared. The ones that are genuinely optional — and safe
to leave blank — are `TREASURY_TOKEN`, `ANALYTICS_USERNAME`,
`ANALYTICS_PASSWORD`, `FORUM_COOKIE`, `APP_BASE_URL` and the three
`DISCORD_WEBHOOK_*`.

`DEFAULT_WORLD_UUID` and `DEFAULT_AUTHORITY` are deliberately **not** in the
egg. Their defaults live in `env.ts`, and a variable that is absent gets that
default — whereas one present-but-blank would override it with `""` and empty
the at-risk page's opening filter.

Deployment-only variables, which have no `.env` equivalent:

| Variable | Meaning |
|---|---|
| `GIT_ADDRESS` / `GIT_BRANCH` | What to deploy. |
| `GIT_USERNAME` / `GIT_TOKEN` | Blank for the public repository. Only for a private fork, where they are baked into the remote URL in `.git/config` so the startup `git fetch` keeps working. |
| `AUTO_UPDATE` | `1` = fetch and `reset --hard` to the branch on every start. |
| `RUN_MIGRATIONS` | `1` = apply migrations and re-apply `views.sql` before starting. Leave on; both are idempotent. |

One caution: panel variables are visible to anyone with access to the server in
the panel, including the Treasury JWT and the forum cookie. Keep the server's
subuser list to people who are allowed to hold those.

## 5. Reverse proxy and TLS

`deploy/caddy/Caddyfile.example` proxies a hostname to the loopback allocation.
Copy it into `/etc/caddy/Caddyfile` (or a `sites-enabled` include), set the
hostname and the allocation port, `systemctl reload caddy`.

Then set **`APP_BASE_URL`** to the same public URL. It is what Discord alerts
link back to; unset, they carry no links.

The dashboard has no login. Either keep it on a VPN/private network, or
uncomment the `basic_auth` block in the example (`caddy hash-password`).

## 6. Start, stop, deploy

**Start** runs `deploy/pelican/start.sh`, which:

1. fetches and hard-resets to `GIT_BRANCH` (when `AUTO_UPDATE=1`),
2. runs `npm ci` only if `package-lock.json` changed or `node_modules` is gone,
3. runs `next build` only if `.next/BUILD_ID` is missing or `HEAD` moved,
4. applies migrations and views, retrying five times while Postgres comes up,
5. `exec`s `next start` on `${SERVER_PORT}`.

Steps 2 and 3 are fingerprinted in `.deploy-state/`. Delete that directory to
force a clean rebuild on the next start. The console reports each decision, so
a restart that rebuilds is visible as it happens.

The panel marks the server **running** when it sees `Ready in`. A first start
that rebuilds sits in *Starting* for a few minutes — that is the build, not a
hang; watch the console.

**Stop** sends `^C`. That matters: `bootSyncWorker` installs SIGINT/SIGTERM
handlers that drain the running job, close the run, and release the advisory
lock. **Kill** skips all of that and leaves jobs marked `running` — recoverable
(`reclaimAbandoned` picks them up on the next boot) but avoidable.

**Deploying a change** is: push to the branch, then Restart. With
`AUTO_UPDATE=1` that fetches, rebuilds if the revision moved, migrates, and
comes back up. Roll back by pointing `GIT_BRANCH` at a tag and restarting.

## 7. One worker, and only one

`SYNC_WORKER_ENABLED=true` on exactly one server. The worker holds a session
advisory lock precisely so a second process cannot double the request rate
against four APIs that publish no rate limits — a second instance logs
`another process holds the worker lock` and serves the dashboard read-only,
which is a legitimate way to run a second web instance if you ever want one.

The same applies to running `npm run sync -- --worker` on the node while the
Pelican server is up: it will refuse, correctly.

## 8. Backups

The data is expensive to reacquire, not cheap. Back up the volume-level dump,
not the crawl:

```sh
# /etc/cron.daily/pruneroo-backup
docker exec pruneroo-db pg_dump -U pruneroo -d pruneroo \
  --format=custom --compress=9 --no-owner --no-privileges \
  --exclude-table-data=api_requests \
  > /var/backups/pruneroo-$(date -u +\%Y\%m\%d).dump
find /var/backups -name 'pruneroo-*.dump' -mtime +14 -delete
```

Restore with the same `restore-prod-db.sh` used for the initial import.

## 9. When it goes wrong

| Symptom | Cause |
|---|---|
| Install log ends at exit 137 | The build was OOM-killed. Raise the server's memory to 3072MB+. |
| Pages hang ~90s, console shows `connect ETIMEDOUT …:5432` | The container cannot reach Postgres. Check the gateway address in `DATABASE_URL` against `docker network inspect pelican_nw`, and that the compose `ports:` bind matches it. |
| `Invalid environment configuration` on boot | A required variable was cleared to blank in the panel. See §4. |
| `another process holds the worker lock` | A previous process is still alive, or a CLI worker is running. Expected on a second instance. |
| Server stuck in *Starting* | Either the build is still running (check the console) or nothing printed `Ready in`. |
| Install fails cloning | A branch name that does not exist — or, if you pointed `GIT_ADDRESS` at a private fork, a missing `GIT_TOKEN`. |
| Restore refuses with "a sync worker still holds the advisory lock" | Stop the Pelican server first. |
