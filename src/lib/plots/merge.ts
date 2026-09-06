/**
 * Working out which plots are merged.
 *
 * A merged plot is several sub-plots treated as one property. The Property
 * Standards Act §18 makes the distinction that matters here: merged plots count
 * as their **individual sub-plots** for ownership limits (§18(1)), but as **one
 * unified property** for everything else including eviction proceedings
 * (§18(2)).
 *
 * Being named together in one eviction report is the signal that plots are
 * merged, but it is not sufficient on its own. Two further conditions must
 * hold, and both are checked here:
 *
 *   1. **Same owner.** Plots with different owners cannot be merged, however
 *      they were reported.
 *   2. **Geographically contiguous.** Real merged plots abut: across 660 of the
 *      pairs observed in live data the bounding boxes are 0–2 blocks apart,
 *      after which the distribution jumps to tens and then thousands of blocks.
 *
 * Contiguity is tested as *connectivity*, not as every-pair-adjacent. A row of
 * four merged plots is a chain — its two ends can be far apart while every plot
 * still touches a neighbour.
 */

export interface MergeCandidate {
  worldUuid: string;
  wgRegionId: string;
  /** Titleholder for freehold, tenant for leasehold; null when unknown. */
  ownerUuid: string | null;
  /** Bounding box in world coordinates; null when dimensions are missing. */
  bounds: { x0: number; x1: number; z0: number; z1: number } | null;
}

export type MergeRejection =
  | "single-plot"
  | "different-owners"
  | "unknown-owner"
  | "missing-dimensions"
  | "not-contiguous";

export interface MergeResult {
  status: "merged" | "rejected";
  reason: MergeRejection | null;
  members: MergeCandidate[];
  ownerUuid: string | null;
}

/**
 * Maximum gap, in blocks, between two plots still considered touching.
 *
 * Two is what the data supports: adjacent WorldGuard regions sit 0, 1 or 2
 * blocks apart, and the next observed gap is 4 with only a couple of pairs.
 */
export const ADJACENCY_BLOCKS = 2;

function gap(a: NonNullable<MergeCandidate["bounds"]>, b: NonNullable<MergeCandidate["bounds"]>): number {
  const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
  const dz = Math.max(0, Math.max(a.z0, b.z0) - Math.min(a.z1, b.z1));
  // Chebyshev distance: plots touching on one axis while overlapping on the
  // other are adjacent, which diagonal-aware Euclidean distance would blur.
  return Math.max(dx, dz);
}

export function areAdjacent(
  a: MergeCandidate,
  b: MergeCandidate,
  maxGap = ADJACENCY_BLOCKS,
): boolean {
  if (!a.bounds || !b.bounds) return false;
  return gap(a.bounds, b.bounds) <= maxGap;
}

/** Whether every plot reaches every other through a chain of adjacencies. */
export function isContiguous(
  members: MergeCandidate[],
  maxGap = ADJACENCY_BLOCKS,
): boolean {
  if (members.length < 2) return false;

  const seen = new Set<number>([0]);
  const queue = [0];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (let i = 0; i < members.length; i += 1) {
      if (seen.has(i)) continue;
      if (areAdjacent(members[current], members[i], maxGap)) {
        seen.add(i);
        queue.push(i);
      }
    }
  }
  return seen.size === members.length;
}

/**
 * Decide whether a set of plots named in one report is a genuine merge.
 *
 * Rejections carry a reason rather than disappearing: a report naming plots
 * with different owners is worth seeing, because it usually means the report or
 * the ownership data is wrong.
 */
export function evaluateMerge(
  members: MergeCandidate[],
  maxGap = ADJACENCY_BLOCKS,
): MergeResult {
  if (members.length < 2) {
    return { status: "rejected", reason: "single-plot", members, ownerUuid: null };
  }

  const owners = new Set(members.map((m) => m.ownerUuid));
  if (owners.has(null)) {
    return {
      status: "rejected",
      reason: "unknown-owner",
      members,
      ownerUuid: null,
    };
  }
  if (owners.size > 1) {
    return {
      status: "rejected",
      reason: "different-owners",
      members,
      ownerUuid: null,
    };
  }

  const ownerUuid = members[0].ownerUuid;

  if (members.some((m) => !m.bounds)) {
    return {
      status: "rejected",
      reason: "missing-dimensions",
      members,
      ownerUuid,
    };
  }

  if (!isContiguous(members, maxGap)) {
    return {
      status: "rejected",
      reason: "not-contiguous",
      members,
      ownerUuid,
    };
  }

  return { status: "merged", reason: null, members, ownerUuid };
}

export const REJECTION_LABELS: Record<MergeRejection, string> = {
  "single-plot": "Only one plot named",
  "different-owners": "Plots have different owners, so they cannot be merged",
  "unknown-owner": "Owner unknown for at least one plot",
  "missing-dimensions": "Plot boundaries not available",
  "not-contiguous": "Plots are not adjacent to one another",
};
