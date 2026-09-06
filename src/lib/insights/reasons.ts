/**
 * The reasons a property lands on the at-risk list.
 *
 * Kept in its own module with no imports: the filter bar is a client component
 * and needs the vocabulary, while `at-risk.ts` pulls in the database client.
 * Importing the list from there dragged `pg` into the browser bundle, which
 * fails at build time on `require('dns')`.
 */

export type FlagReason = "inactive" | "banned" | "deported" | "over-limit";

export const ALL_REASONS: FlagReason[] = [
  "inactive",
  "banned",
  "deported",
  "over-limit",
];
