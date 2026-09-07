# Deploying to a Pelican server

The whole application is one long-running Node process. `next start` serves the
dashboard and `src/instrumentation.ts` boots the sync worker inside the same
process, so it fits a Pelican server, which gives you one container, one startup
command and one stop signal.

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
  Discord webhooks. Same values as `.env`, and the README has the table.

## 1. Postgres on the host

```sh
scp -r deploy/postgres your-node:/opt/pruneroo-db
ssh your-node
cd /opt/pruneroo-db
cp .env.example .env && $EDITOR .env      # set POSTGRES_PASSWORD
```

Confirm the bridge address before bringing it up. The compose file binds
Postgres to that address and nothing else, so a wrong value means either an
unreachable database or one published to the world:

```sh
docker network inspect pelican_nw -f '{{(index .IPAM.Config 0).Gateway}}'   # expect 172.18.0.1
docker compose up -d
```

Then verify from inside the network the app will actually run in. Do this now,
because from inside the container the failure is a 90-second `ETIMEDOUT` per
page rather than a clear refusal:

```sh
docker run --rm --network pelican_nw postgres:17-alpine \
  psql "postgres://pruneroo:PASSWORD@172.18.0.1:5432/pruneroo" -c "select 1"
```

`shm_size: 512mb` is not decoration. Docker defaults `/dev/shm` to 64MB, which
the insight views exhaust as soon as a parallel query needs a shared hash table
(`could not resize shared memory segment`, SQLSTATE 53100).

## 2. Move the existing data across

The dev database already holds ~95k players, ~63k Treasury balances and the
eviction-report history. Do not re-crawl to rebuild it. The balance backfill
alone is ~122,000 requests against someone else's game server, rate-limited to
about seven hours. Transfer it instead.

On the dev machine, with `docker compose up -d db` running:

```sh
./deploy/scripts/dump-dev-db.sh                 # -> pruneroo-<timestamp>.dump (~14MB)
scp pruneroo-*.dump your-node:/tmp/
```

On the node, with the Pelican server **stopped**, or before it is created:

```sh
scp deploy/scripts/restore-prod-db.sh your-node:/opt/pruneroo-db/
ssh your-node /opt/pruneroo-db/restore-prod-db.sh /tmp/pruneroo-<timestamp>.dump
```

What that moves, and why it matters:

- **The full schema, including the views and `drizzle.__drizzle_migrations`.**
  Production therefore starts already migrated, and the `db:migrate` on first
  boot is a no-op that only re-applies `views.sql` with `CREATE OR REPLACE`.
- **`notification_deliveries` and the `seeded.<channel>` watermarks.** This is
  the reason to transfer rather than start empty. A fresh database would treat
  every stored ban as unseen, and the first notifier run would seed thousands of
  items instead of announcing the next real one. See
  [Discord alerts](alerts.md#enabling-a-webhook-is-not-an-event).
- **`sync_jobs`, including the Treasury sweep backlog.** The backfill resumes
  where dev left it rather than starting over.
- **Not `api_requests`.** It is a rolling audit log and only the last hour is
  ever read by `getSourceHealth`, so the dump excludes ~166k rows of history.
  Pass `INCLUDE_REQUEST_LOG=1` to keep them.

The restore script refuses to run while anything holds the worker's advisory
lock, `ADVISORY_LOCK_KEY` in `src/lib/sync/lock.ts`. It then drops and recreates
the database and runs `ANALYZE`, because the dump carries no planner statistics
and the insight views join ~95k players against ~63k balances.

Keep the major versions equal on both ends, 17 here. `pg_restore` will not read
an archive from a newer server.

## 3. Import the egg and create the server

1. **Admin → Eggs → Import Egg**, then `deploy/pelican/egg-pruneroo.json`.
   It is `PTDL_v2`, which is the format Pelican imports and the format the whole
   `pelican-eggs` library ships in.
2. **Create a server** on the Pruneroo egg:
   - **Docker image**: `ghcr.io/pelican-eggs/yolks:nodejs_24`
   - **Memory**: 3072MB or more. `next build` is the peak, not serving. Below
     ~2GB the cgroup limit OOM-kills the build and the install log ends at exit
     137.
   - **Disk**: 5120MB or more. `node_modules` is ~700MB, `.next` is ~1GB, plus
     the git checkout.
   - **Allocation**: on `172.18.0.1`, the `pelican_nw` bridge gateway, and mark
     it **primary**. Wings then publishes the port on a host interface that
     Caddy can reach and nothing off the machine can route to. The dashboard has
     no authentication of its own and it lists player balances and ban history,
     so it should not be on a public address. The panel's dropdown offers only
     the addresses Wings detected, so `127.0.0.1` is usually not among them;
     the difference that matters is that other containers on `pelican_nw` can
     reach the bridge gateway, which counts only if the node runs servers you do
     not control. If you need loopback, the application API accepts it:
     `POST /api/application/nodes/<id>/allocations` with `allocation_ip` and
     `allocation_ports`.

     A server with no primary allocation gets `SERVER_PORT=0` from Wings, which
     `start.sh` refuses rather than binding a random port.
   - **CPU**: leave unlimited if you can, since the build is parallel.
3. **Fill in the variables**, covered in §4. `GIT_ADDRESS` already points at the
   public repository, so what needs filling is `DATABASE_URL`, `TREASURY_TOKEN`,
   the Analytics login and `FORUM_COOKIE`.

Installation clones the repo and runs `deploy/pelican/install.sh`, which is
`npm ci` then `next build`, in a `node:24-trixie-slim` container. Watch it in
the install log. It takes a few minutes on first run, most of it `npm ci`.

The build needs no database. Every page is `force-dynamic`, so nothing is
prerendered against Postgres. It does need the rest of the environment to
validate, `src/lib/env.ts`, which Wings supplies from the egg variables.

## 4. Variables behave differently in a panel than in a `.env` file

**A blank field is an empty string, not an unset variable.** Wings passes every
variable the egg defines, blank ones included. `.env` semantics are the
opposite, and `src/lib/env.ts` goes out of its way to read a blank line as "not
configured", but only the fields written for it, `optionalSecret` and
`numberOrDefault`, survive an empty string. The rest do not.
`INACTIVITY_THRESHOLD_HOURS=""` is `Number("") === 0` without a word of
complaint, and a blank `REALTY_BASE_URL` fails `z.url()` and the app will not
boot.

So the egg ships a real default for every non-secret variable, and those fields
should be edited, never cleared. The ones that are genuinely optional, and safe
to leave blank, are `TREASURY_TOKEN`, `ANALYTICS_USERNAME`,
`ANALYTICS_PASSWORD`, `FORUM_COOKIE`, `APP_BASE_URL` and the three
`DISCORD_WEBHOOK_*`.

**Do not wrap a value in quotes.** In a `.env` file `FOO="bar"` and `FOO=bar`
are the same thing, because dotenv strips the quotes. A panel field is the raw
value, so the quotes become part of it and a URL stops being a URL. The boot
error quotes the value it received back at you, which is what makes this
visible: `APP_BASE_URL: Invalid URL (received "\"https://example.com\"")`.

`APP_BASE_URL` needs the scheme when it is set. It becomes the `url` on every
Discord embed, so `pruneroo.example.com` without `https://` is rejected by
Discord rather than by us. The app validates it at boot for that reason.

`DEFAULT_WORLD_UUID` and `DEFAULT_AUTHORITY` are deliberately **not** in the
egg. Their defaults live in `env.ts`, and an absent variable gets that default,
whereas one present-but-blank would override it with `""` and empty the at-risk
page's opening filter.

Deployment-only variables, which have no `.env` equivalent:

| Variable | Meaning |
|---|---|
| `GIT_ADDRESS` / `GIT_BRANCH` | What to deploy. |
| `GIT_USERNAME` / `GIT_TOKEN` | Blank for the public repository. Only for a private fork, where they are baked into the remote URL in `.git/config` so the startup `git fetch` keeps working. |
| `AUTO_UPDATE` | `1` = fetch and `reset --hard` to the branch on every start. |
| `RUN_MIGRATIONS` | `1` = apply migrations and re-apply `views.sql` before starting. Leave it on, since both are idempotent. |

One caution: panel variables are visible to anyone with access to the server in
the panel, including the Treasury JWT and the forum cookie. Keep the server's
subuser list to people who are allowed to hold those.

## 5. Reverse proxy and TLS

Caddy goes on the Wings host, because that is where the allocation is published.
Install it from the official apt repository:

```sh
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

That installs a `caddy` systemd service running as the `caddy` user, reading
`/etc/caddy/Caddyfile`, keeping certificates in `/var/lib/caddy`. Copy
`deploy/caddy/Caddyfile.example` into place, set the hostname and the allocation
port, then `sudo systemctl reload caddy`. Reload rather than restart: a reload
is atomic, so a bad config is rejected and the previous one keeps serving.

Then set **`APP_BASE_URL`** to the same public URL, with the scheme. It is what
Discord alerts link back to, and unset they carry no links.

The dashboard has no login. Either keep it on a private network, or uncomment
the `basic_auth` block in the example and generate a hash with
`caddy hash-password`.

### A host the internet cannot reach

The HTTP-01 and TLS-ALPN challenges both require Let's Encrypt to connect to the
box, so a LAN-only install needs DNS-01. The stock apt binary has no DNS
provider modules, so add one and stop apt from replacing the binary:

```sh
sudo caddy add-package github.com/caddy-dns/cloudflare
sudo apt-mark hold caddy          # `sudo caddy upgrade` from here on
sudo systemctl restart caddy      # add-package only swaps the binary on disk
caddy list-modules | grep cloudflare
```

Create a Cloudflare API token with **Zone:Zone:Read** and **Zone:DNS:Edit**,
scoped to the zone. The module dropped support for the global API key, so a
scoped token is the only option. Pass it through systemd rather than the
Caddyfile:

```sh
printf 'CF_API_TOKEN=%s\n' '<token>' | sudo tee /etc/caddy/cloudflare.env >/dev/null
sudo chmod 600 /etc/caddy/cloudflare.env
sudo systemctl edit caddy         # [Service] EnvironmentFile=/etc/caddy/cloudflare.env
```

While editing that override, check `systemctl cat caddy | grep ExecStart`. The
upstream unit runs `caddy run --environ`, and `--environ` prints every
environment variable at startup, so the token lands in the journal in clear
text. Clear it in the override:

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile
```

Then the site block takes a `tls` directive:

```caddyfile
	tls {
		dns cloudflare {env.CF_API_TOKEN}
		resolvers 1.1.1.1 1.0.0.1
	}
```

`resolvers` matters on a LAN. Caddy polls DNS to confirm the challenge record
propagated, and a split-horizon or caching resolver can fail to see a record
Cloudflare has already published.

Issuance needs only the TXT record Caddy creates and removes. The A record is
for your own clients: either point one at the private address as DNS-only, or
publish nothing and resolve the name on your own DNS. With DNS-01, ports 80 and
443 need no inbound access from the internet at all.

## 6. Start, stop, deploy

**Start** runs `deploy/pelican/start.sh`, which:

1. fetches and hard-resets to `GIT_BRANCH`, when `AUTO_UPDATE=1`,
2. runs `npm ci` only if `package-lock.json` changed or `node_modules` is gone,
3. runs `next build` only if `.next/BUILD_ID` is missing or `HEAD` moved,
4. applies migrations and views, retrying five times while Postgres comes up,
5. `exec`s `next start` on `${SERVER_PORT}`.

Steps 2 and 3 are fingerprinted in `.deploy-state/`. Delete that directory to
force a clean rebuild on the next start. The console reports each decision, so a
restart that rebuilds is visible as it happens.

The panel marks the server **running** when it sees `Ready in`. A first start
that rebuilds sits in *Starting* for a few minutes. That is the build, not a
hang, and the console shows it.

**Stop** sends `^C`, which matters. `bootSyncWorker` installs SIGINT and SIGTERM
handlers that drain the running job, close the run, and release the advisory
lock. **Kill** skips all of that and leaves jobs marked `running`.
`reclaimAbandoned` picks them up on the next boot, so it is recoverable, but
avoidable.

**Deploying a change** is push to the branch, then Restart. With
`AUTO_UPDATE=1` that fetches, rebuilds if the revision moved, migrates, and
comes back up. Roll back by pointing `GIT_BRANCH` at a tag and restarting.

## 7. One worker, and only one

Set `SYNC_WORKER_ENABLED=true` on exactly one server. The worker holds a session
advisory lock precisely so a second process cannot double the request rate
against four APIs that publish no rate limits. A second instance logs
`another process holds the worker lock` and serves the dashboard read-only,
which is a legitimate way to run a second web instance if you ever want one.

The same applies to running `npm run sync -- --worker` on the node while the
Pelican server is up. It will refuse, correctly.

## 8. Backups

The data is expensive to reacquire. Back up the dump, not the crawl:

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
| Install log ends at exit 137 | The build was OOM-killed. Raise the server's memory to 3072MB or more. |
| Pages hang ~90s, console shows `connect ETIMEDOUT …:5432` | The container cannot reach Postgres. Check the gateway address in `DATABASE_URL` against `docker network inspect pelican_nw`, and that the compose `ports:` bind matches it. |
| `Invalid environment configuration` on boot or during the build | A variable was cleared to blank, or wrapped in quotes that a `.env` file would have stripped. The error quotes the value it received; check for `\"` around it or trailing whitespace. See §4. |
| `another process holds the worker lock` | A previous process is still alive, or a CLI worker is running. Expected on a second instance. |
| Server stuck in *Starting* | Either the build is still running, which the console shows, or nothing printed `Ready in`. |
| Install fails cloning | A branch name that does not exist, or a missing `GIT_TOKEN` if you pointed `GIT_ADDRESS` at a private fork. |
| Console says `starting Next on 0.0.0.0:0`, or Caddy returns 502 | The server has no primary allocation, so Wings passes `SERVER_PORT=0`. Mark an allocation primary in the panel and restart. `start.sh` refuses to start on it rather than binding a random port. |
| All three notifiers fail with `Discord webhook returned HTTP 400: {"embeds": ["0"]}` | Discord rejected the embed. Usually `APP_BASE_URL` without a scheme, which becomes an invalid embed `url`. **Send test** on `/sync` uses the same field, so a failing test confirms it. |
| Caddy reload fails with `open /var/log/caddy/...: permission denied` | The log directory does not exist or is not writable by the `caddy` user: `sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy`. The previous config keeps serving until the reload succeeds. |
| Certificates stop renewing after an apt upgrade | `apt` replaced the binary built by `caddy add-package`, dropping the DNS module. `apt-mark hold caddy` and upgrade with `sudo caddy upgrade`. |
| Restore refuses with "a sync worker still holds the advisory lock" | Stop the Pelican server first. |
