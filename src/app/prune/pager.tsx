"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * Page and page-size controls.
 *
 * Page size is a short whitelist rather than a free number, because it is also
 * how many balances the next load will re-read upstream.
 */
export function Pager({
  page,
  pageCount,
  size,
  sizes,
}: {
  page: number;
  pageCount: number;
  size: number;
  /**
   * Passed in rather than imported: the whitelist lives beside the query
   * parser, which value-imports the env schema, and that has no business in a
   * browser bundle.
   */
  sizes: number[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const go = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      router.push(`/prune?${params.toString()}`);
    },
    [router, searchParams],
  );

  const toPage = (next: number) =>
    go((params) => {
      if (next <= 1) params.delete("page");
      else params.set("page", String(next));
    });

  const buttonClass =
    "rounded border border-border-subtle px-2 py-1 text-xs transition-colors " +
    "hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <button
        type="button"
        className={buttonClass}
        disabled={page <= 1}
        onClick={() => toPage(page - 1)}
      >
        ← Previous
      </button>
      <span className="text-muted">
        Page {page} of {pageCount.toLocaleString()}
      </span>
      <button
        type="button"
        className={buttonClass}
        disabled={page >= pageCount}
        onClick={() => toPage(page + 1)}
      >
        Next →
      </button>

      <label className="ml-auto flex items-center gap-2 text-xs text-muted">
        Rows per page
        <select
          value={size}
          onChange={(e) =>
            go((params) => {
              params.set("size", e.target.value);
              // Row 51 of the old paging is not row 51 of the new one.
              params.delete("page");
            })
          }
          className="rounded border border-border-subtle bg-background px-2 py-1 text-xs"
        >
          {sizes.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
