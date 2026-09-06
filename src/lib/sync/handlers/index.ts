import {
  handleAnalyticsPlayerDetail,
  handleAnalyticsPlayersTable,
} from "./analytics";
import {
  handleForumEvictionReports,
  handleForumListingPage,
} from "./forum";
import { handleRebuildMerges } from "./merges";
import {
  handleNotifyAtRisk,
  handleNotifyPrune,
  handleNotifyPunishments,
} from "./notify";
import {
  handlePunishmentCrawl,
  handlePunishmentStats,
} from "./punishments";
import {
  handleRealtyActivity,
  handleRealtyRegionDetail,
  handleRealtyRegionsIndex,
  handleRealtyStats,
} from "./realty";
import {
  handleTreasuryAccountResolve,
  handleTreasuryBalance,
  handleTreasuryBalanceSweep,
  handleTreasuryPruneBalanceSweep,
  handleTreasuryPruneSweep,
  handleTreasuryResolveSweep,
} from "./treasury";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (payload: any) => Promise<void>;

/**
 * Job kind -> handler.
 *
 * Kinds ending in `.stats` are the O(1) change probes; they are the only jobs
 * the scheduler runs on a timer. Everything expensive is enqueued by a probe
 * that saw something actually change.
 */
export const HANDLERS: Record<string, Handler> = {
  "punishments.stats": handlePunishmentStats,
  "punishments.crawl": handlePunishmentCrawl,

  "realty.stats": handleRealtyStats,
  "realty.regions.index": handleRealtyRegionsIndex,
  "realty.region.detail": handleRealtyRegionDetail,
  "realty.activity": handleRealtyActivity,

  "analytics.playersTable": handleAnalyticsPlayersTable,
  "analytics.player.detail": handleAnalyticsPlayerDetail,

  "treasury.resolve.sweep": handleTreasuryResolveSweep,
  "treasury.account.resolve": handleTreasuryAccountResolve,
  "treasury.balance.sweep": handleTreasuryBalanceSweep,
  "treasury.balance": handleTreasuryBalance,
  "treasury.prune.sweep": handleTreasuryPruneSweep,
  "treasury.prune.balance.sweep": handleTreasuryPruneBalanceSweep,

  "forum.evictionReports": handleForumEvictionReports,
  "forum.listing.page": handleForumListingPage,

  // Local recomputation; makes no upstream requests.
  "plots.merges.rebuild": handleRebuildMerges,

  // Local queries plus a Discord POST; no upstream API is re-read.
  "notify.punishments": handleNotifyPunishments,
  "notify.prune": handleNotifyPrune,
  "notify.atRisk": handleNotifyAtRisk,
};

export type JobKind = keyof typeof HANDLERS;

export function sourceForKind(kind: string): string {
  return kind.split(".")[0];
}
