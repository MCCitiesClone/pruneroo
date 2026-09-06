-- Insight views. Re-applied with CREATE OR REPLACE on every `npm run db:migrate`.
--
-- Deliberately *not* parameterised by the inactivity threshold: these expose raw
-- measurements, and `src/lib/insights/at-risk.ts` applies the threshold so the UI
-- can tune it per request.

-- ---------------------------------------------------------------------------
-- Every (region, player, role) pair, unpivoted from the contract tables.
--
-- Realty's titleholder/landlord/tenant and WorldGuard's owners/members are
-- genuinely different concepts, so both are surfaced with distinct role labels
-- rather than being conflated.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_region_stakeholders AS
  SELECT world_uuid, wg_region_id, titleholder_uuid AS player_uuid,
         'titleholder'::text AS role
    FROM region_freehold WHERE titleholder_uuid IS NOT NULL
  UNION ALL
  SELECT world_uuid, wg_region_id, authority_uuid, 'authority'
    FROM region_freehold WHERE authority_uuid IS NOT NULL
  UNION ALL
  SELECT world_uuid, wg_region_id, landlord_uuid, 'landlord'
    FROM region_leasehold WHERE landlord_uuid IS NOT NULL
  UNION ALL
  SELECT world_uuid, wg_region_id, tenant_uuid, 'tenant'
    FROM region_leasehold WHERE tenant_uuid IS NOT NULL
  UNION ALL
  SELECT world_uuid, wg_region_id, player_uuid,
         CASE WHEN domain = 'owner' THEN 'wg_owner' ELSE 'wg_member' END
    FROM region_members WHERE player_uuid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Active punishments per player.
--
-- The upstream API reports no usable enforcement state: its `active` field is
-- hardcoded false on every record, and a *revoked* ban keeps reporting
-- label='Permanent' with end=0 forever. So "active" is derived here.
--
-- The load-bearing clause is the login cross-check. A ban prevents connecting,
-- so if Analytics has seen the player since the ban began, that ban is
-- provably not being enforced — it was lifted, and the punishments API simply
-- has no field to say so. Without this, 606 of 2,718 "active" bans (22%) were
-- false positives, including players who logged in yesterday.
--
-- The check is deliberately limited to BAN: a MUTE does not prevent login, so
-- seeing the player proves nothing about a mute. KICK is excluded entirely —
-- it is an instantaneous event, never an ongoing state.
-- ---------------------------------------------------------------------------
-- A deportation carries its own lifecycle inside the reason text, parsed into
-- deportation_completed_at / deportation_expires_at on ingest. The underlying
-- WARN is frequently INFINITE, so `end_at` says nothing about whether the
-- deportation is still being served — "Completed <timestamp>" does.
-- Dropped rather than replaced: CREATE OR REPLACE can only append columns, and
-- both this view and v_player_flags below gain columns in the middle. Dependents
-- go first and are recreated further down this file.
-- Dependants are dropped before their dependencies, deepest first, or the
-- DROPs below fail on re-run. This file is re-applied on every `npm run
-- db:migrate`, so it has to be idempotent: v_prune_candidates selects from
-- v_player_flags, which means a fresh database succeeds (the dependant does not
-- exist yet) while every subsequent migrate fails on "cannot drop ... because
-- other objects depend on it". Anything added here that reads another view in
-- this file must be dropped in this block too.
DROP VIEW IF EXISTS v_prune_candidates;
DROP VIEW IF EXISTS v_property_stakeholder_flags;
DROP VIEW IF EXISTS v_player_flags;
DROP VIEW IF EXISTS v_active_punishments;

CREATE VIEW v_active_punishments AS
  SELECT p.*,
         -- When the deportation lapses. The upstream `end` is meaningless for
         -- deportations (every one reports permanent), so the real bound is the
         -- expiry parsed out of the reason text; `end_at` is the fallback for
         -- the handful that carry a real one.
         CASE WHEN p.is_deportation
              THEN COALESCE(p.deportation_expires_at, p.end_at) END
           AS deportation_ends_at,
         -- How serious the deportation is, which decides whether it is grounds
         -- to evict. A player deported for a few weeks is coming back to their
         -- property; one deported indefinitely or for four months and up is not.
         CASE
           WHEN NOT p.is_deportation THEN NULL
           WHEN COALESCE(p.deportation_expires_at, p.end_at) IS NULL
             THEN 'indefinite'
           WHEN COALESCE(p.deportation_expires_at, p.end_at)
                >= COALESCE(p.start_at, now()) + interval '4 months'
             THEN 'long'
           ELSE 'limited'
         END AS deportation_kind
    FROM punishments p
    LEFT JOIN player_analytics a ON a.player_uuid = p.victim_uuid
   WHERE p.victim_uuid IS NOT NULL
     AND p.withdrawn_at IS NULL
     AND p.type <> 'KICK'
     AND (p.end_at IS NULL OR p.end_at > now())
     AND NOT (
       p.type = 'BAN'
       AND a.last_seen_at IS NOT NULL
       AND p.start_at IS NOT NULL
       AND a.last_seen_at > p.start_at
     )
     AND NOT (
       p.is_deportation
       AND (
         p.deportation_completed_at IS NOT NULL
         OR (p.deportation_expires_at IS NOT NULL
             AND p.deportation_expires_at <= now())
       )
     );

-- ---------------------------------------------------------------------------
-- One row per known player: punishment state plus 30-day playtime.
--
-- `playtime_30d_source` is load-bearing and is surfaced in the UI — a row
-- backed by 'unknown' must never be presented as a measured zero.
--
--   analytics_detail  measured, from /v1/player online_activity.active_playtime_30d
--   inferred_zero     exact by deduction: last seen over 30 days ago, so the
--                     30-day window necessarily contains no playtime
--   unknown           not yet fetched; excluded from inactivity results
-- ---------------------------------------------------------------------------
CREATE VIEW v_player_flags AS
WITH punishment_state AS (
  SELECT victim_uuid AS player_uuid,
         bool_or(type = 'BAN')      AS is_banned,
         bool_or(is_deportation)    AS is_deported,
         -- Grounds for eviction: an indefinite or long deportation, as opposed
         -- to a limited one the player will simply serve out.
         bool_or(deportation_kind IN ('indefinite', 'long'))
                                    AS is_long_deported,
         CASE
           WHEN bool_or(deportation_kind = 'indefinite') THEN 'indefinite'
           WHEN bool_or(deportation_kind = 'long')       THEN 'long'
           WHEN bool_or(deportation_kind = 'limited')    THEN 'limited'
         END                        AS deportation_kind,
         -- Null when any active deportation is open-ended, since no date bounds
         -- it; otherwise the last one to lapse.
         CASE
           WHEN bool_or(is_deportation AND deportation_ends_at IS NULL)
             THEN NULL
           ELSE max(deportation_ends_at)
         END                        AS deportation_ends_at,
         max(CASE WHEN type = 'BAN'    THEN reason END) AS ban_reason,
         max(CASE WHEN is_deportation  THEN reason END) AS deportation_reason,
         max(CASE WHEN type = 'BAN'    THEN start_at END) AS banned_at,
         max(CASE WHEN is_deportation  THEN start_at END) AS deported_at
    FROM v_active_punishments
   GROUP BY victim_uuid
)
SELECT
  p.uuid                                AS player_uuid,
  p.name                                AS player_name,
  a.last_seen_at,
  a.registered_at,
  a.playtime_active_ms                  AS lifetime_playtime_ms,
  a.session_count,
  COALESCE(ps.is_banned,   false)       AS is_banned,
  COALESCE(ps.is_deported, false)       AS is_deported,
  COALESCE(ps.is_long_deported, false)  AS is_long_deported,
  -- Deported, but only for a limited period. Their playtime is zero *because*
  -- they are deported, so inactivity says nothing about them until it lapses.
  COALESCE(ps.is_deported, false)
    AND NOT COALESCE(ps.is_long_deported, false)
                                        AS is_limited_deported,
  ps.deportation_kind,
  ps.deportation_ends_at,
  ps.ban_reason,
  ps.deportation_reason,
  ps.banned_at,
  ps.deported_at,
  CASE
    WHEN a.last_seen_at IS NOT NULL
     AND a.last_seen_at < now() - interval '30 days' THEN 0
    WHEN w.active_playtime_30d_ms IS NOT NULL THEN w.active_playtime_30d_ms
    ELSE NULL
  END                                   AS playtime_30d_ms,
  CASE
    WHEN a.last_seen_at IS NOT NULL
     AND a.last_seen_at < now() - interval '30 days' THEN 'inferred_zero'
    WHEN w.active_playtime_30d_ms IS NOT NULL THEN 'analytics_detail'
    ELSE 'unknown'
  END                                   AS playtime_30d_source,
  w.fetched_at                          AS playtime_30d_fetched_at,
  acct.account_id                       AS treasury_account_id,
  bal.balance                           AS balance,
  bal.balance_raw                       AS balance_raw
FROM players p
LEFT JOIN player_analytics       a    ON a.player_uuid    = p.uuid
LEFT JOIN player_activity_window w    ON w.player_uuid    = p.uuid
LEFT JOIN punishment_state       ps   ON ps.player_uuid   = p.uuid
LEFT JOIN treasury_accounts      acct ON acct.player_uuid = p.uuid
LEFT JOIN treasury_balances      bal  ON bal.account_id   = acct.account_id;

-- ---------------------------------------------------------------------------
-- The flagship join: every property with its stakeholder and that player's
-- flags. One row per (region, stakeholder) pair; the threshold that decides
-- "at risk" is applied by the query layer, not here.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- Regions currently covered by an open eviction report.
--
-- A report can name several plots ("c176/c177"), so this is one row per
-- (region, report). Only *active* reports appear: a resolved one still shows on
-- the region page, but no longer suppresses the plot from review.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_region_active_reports AS
  SELECT rr.world_uuid,
         rr.wg_region_id,
         r.thread_id,
         r.title,
         r.prefix,
         r.url,
         r.author,
         r.posted_at
    FROM eviction_report_regions rr
    JOIN eviction_reports r ON r.thread_id = rr.thread_id
   WHERE r.is_active;

-- Dropped rather than replaced: CREATE OR REPLACE cannot reorder or insert
-- columns, and this view gains the authority identity below. Nothing depends
-- on it, so a drop is safe.
DROP VIEW IF EXISTS v_property_stakeholder_flags;
CREATE VIEW v_property_stakeholder_flags AS
SELECT
  r.world_uuid,
  w.name                    AS world_name,
  r.wg_region_id,
  r.state,
  r.contract_type,
  r.tags,
  -- Zoning and area, so the plot-limit context an inspector needs is on the
  -- row itself rather than one click away on the region page.
  r.category,
  r.area,
  r.detail_fetched_at,
  s.role,
  f.player_uuid,
  f.player_name,
  f.is_banned,
  f.is_deported,
  f.is_long_deported,
  f.is_limited_deported,
  f.deportation_kind,
  f.deportation_ends_at,
  f.playtime_30d_ms,
  f.playtime_30d_source,
  f.last_seen_at,
  f.balance,
  COALESCE(fh.price, lh.price)  AS price,
  lh.end_at                     AS lease_end_at,
  fh.accepting_offers,
  lh.accepting_tenants,
  -- The region's authority — the granting/oversight party on a freehold, and a
  -- different concept from the titleholder who owns it. Surfaced independently
  -- of which stakeholder triggered the flag, so a plot flagged via its landlord
  -- still shows the authority responsible for it.
  fh.authority_uuid,
  au.name        AS authority_name,
  lower(au.name) AS authority_name_lower,
  -- Operator curation, so excluded holders can be hidden (or shown on demand).
  (ex.player_uuid IS NOT NULL) AS is_excluded,
  ex.reason                    AS exclusion_reason,
  -- An open eviction report means the plot is already being dealt with, so it
  -- is suppressed from review rather than re-triaged every pass.
  (rep.thread_id IS NOT NULL)  AS has_active_report,
  rep.thread_id                AS report_thread_id,
  rep.title                    AS report_title,
  rep.url                      AS report_url,
  -- Merged plots are filed as a single eviction report (PSA §18(2)), so a
  -- reviewer must see that a plot travels with others before filing on it.
  mg.group_id                  AS merge_group_id,
  mg.member_count              AS merge_member_count
FROM v_region_stakeholders s
JOIN regions          r  ON r.world_uuid = s.world_uuid AND r.wg_region_id = s.wg_region_id
JOIN v_player_flags   f  ON f.player_uuid = s.player_uuid
LEFT JOIN worlds      w  ON w.uuid = r.world_uuid
LEFT JOIN region_freehold  fh ON fh.world_uuid = r.world_uuid AND fh.wg_region_id = r.wg_region_id
LEFT JOIN region_leasehold lh ON lh.world_uuid = r.world_uuid AND lh.wg_region_id = r.wg_region_id
LEFT JOIN players          au ON au.uuid = fh.authority_uuid
LEFT JOIN player_exclusions ex ON ex.player_uuid = f.player_uuid
-- At most one report is surfaced per plot; the region page lists them all.
LEFT JOIN LATERAL (
  SELECT ar.thread_id, ar.title, ar.url
    FROM v_region_active_reports ar
   WHERE ar.world_uuid = r.world_uuid AND ar.wg_region_id = r.wg_region_id
   ORDER BY ar.posted_at DESC NULLS LAST
   LIMIT 1
) rep ON true
LEFT JOIN LATERAL (
  SELECT m.group_id,
         (SELECT count(*)::int FROM plot_merge_members m2 WHERE m2.group_id = m.group_id)
           AS member_count
    FROM plot_merge_members m
    JOIN plot_merge_groups g ON g.id = m.group_id
   WHERE m.world_uuid = r.world_uuid AND m.wg_region_id = r.wg_region_id
     AND g.status = 'merged'
   LIMIT 1
) mg ON true;

-- ---------------------------------------------------------------------------
-- Prune candidates: dormant players holding money.
--
-- A player who has not logged in for a long time and still has a positive
-- balance is money sitting idle that can be returned to the government. The
-- thresholds (how dormant, how much) are applied by
-- `src/lib/insights/prune.ts`, not here — this view exposes only raw
-- measurements, like every other view in this file.
--
-- `balance_source` is the load-bearing column, and is surfaced in the UI for
-- the same reason `playtime_30d_source` is: absence of a balance is not a
-- balance of zero.
--
--   measured   the account was resolved and its balance read
--   no_account Treasury 404'd for this player — they never used the economy,
--              so there is provably nothing to reclaim
--   pending    not yet resolved; unknown, and excluded from the list
--
-- Driven from player_analytics rather than players: last_seen_at is the whole
-- basis of the insight, and a player the roster has never reported cannot be
-- assessed for dormancy at all.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_prune_candidates AS
SELECT
  a.player_uuid,
  p.name                          AS player_name,
  a.last_seen_at,
  a.registered_at,
  a.playtime_active_ms            AS lifetime_playtime_ms,
  a.session_count,
  acct.account_id                 AS treasury_account_id,
  bal.balance,
  bal.balance_raw,
  bal.synced_at                   AS balance_synced_at,
  CASE
    WHEN bal.account_id IS NOT NULL THEN 'measured'
    WHEN miss.player_uuid IS NOT NULL THEN 'no_account'
    ELSE 'pending'
  END                             AS balance_source,
  ex.player_uuid IS NOT NULL      AS is_excluded,
  ex.reason                       AS exclusion_reason,
  -- A banned player's money is still reclaimable, but an operator will want to
  -- see the flag before acting, so it rides along rather than filtering here.
  COALESCE(pf.is_banned, false)   AS is_banned,
  COALESCE(pf.is_deported, false) AS is_deported
FROM player_analytics a
JOIN players p                     ON p.uuid = a.player_uuid
LEFT JOIN treasury_accounts acct   ON acct.player_uuid = a.player_uuid
LEFT JOIN treasury_balances bal    ON bal.account_id = acct.account_id
LEFT JOIN treasury_account_misses miss ON miss.player_uuid = a.player_uuid
LEFT JOIN player_exclusions ex     ON ex.player_uuid = a.player_uuid
LEFT JOIN v_player_flags pf        ON pf.player_uuid = a.player_uuid;
