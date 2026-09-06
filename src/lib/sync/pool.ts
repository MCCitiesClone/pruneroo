/**
 * A bounded worker pool for per-item sync work.
 *
 * Extracted from the prune sweep so its semantics can be tested without a
 * network: the interesting behaviour is the concurrency bound, failure
 * isolation and fatal-abort, none of which is worth discovering in production
 * against someone else's game server.
 *
 * This does **not** control the request rate. Every caller's work still goes
 * through the shared per-host throttle, which holds the token buckets and its
 * own concurrency semaphore; widening this pool cannot breach that. What it
 * fixes is the opposite failure — awaiting each item in turn leaves the
 * allowance idle.
 */

export interface PoolResult {
  /** Items attempted, successes and isolated failures alike. */
  done: number;
  /** Items whose handler threw a non-fatal error. */
  failed: number;
  /** The fatal error that stopped the pool, if one did. */
  aborted: unknown;
}

export async function runPooled<T>(
  items: readonly T[],
  width: number,
  handle: (item: T, index: number) => Promise<void>,
  options: {
    /**
     * Errors that should stop the whole pool rather than be counted and
     * skipped — an open circuit, say, where continuing is pointless.
     */
    isFatal?: (error: unknown) => boolean;
    /** Called every `progressEvery` completions with the running total. */
    onProgress?: (done: number) => Promise<void> | void;
    progressEvery?: number;
  } = {},
): Promise<PoolResult> {
  const { isFatal, onProgress, progressEvery = 10 } = options;

  let cursor = 0;
  let done = 0;
  let failed = 0;
  let aborted: unknown = null;

  // `cursor++` needs no lock: this is one JavaScript thread, so the read and
  // increment cannot interleave with another worker's.
  const worker = async (): Promise<void> => {
    while (aborted === null) {
      const index = cursor++;
      if (index >= items.length) return;

      try {
        await handle(items[index], index);
      } catch (error) {
        if (isFatal?.(error)) {
          aborted = error;
          return;
        }
        // One bad item must not discard the rest of the batch.
        failed += 1;
      }

      done += 1;
      if (onProgress && done % progressEvery === 0) await onProgress(done);
    }
  };

  const lanes = Math.max(1, Math.min(width, items.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));

  return { done, failed, aborted };
}
