/**
 * yard-columns.ts: pure column math for the yard grid. No DOM access.
 */

/** Narrowest plot column in px. Matches the `minmax(112px, ...)` the yard used before. */
export const MIN_PLOT_WIDTH = 112;
/** Viewport width at and below which the yard is capped at three columns. */
export const NARROW_MAX_WIDTH = 760;
export const NARROW_COLS = 3;

/** How many 112 px columns fit a yard of this width (at least 1; 3 at the narrow breakpoint). */
export function maxColumns(yardWidth: number, narrow: boolean): number {
  if (narrow) return NARROW_COLS;
  return Math.max(1, Math.floor(yardWidth / MIN_PLOT_WIDTH));
}

/**
 * Column count for `n` plots when at most `maxCols` fit: use the fewest rows that fit, then
 * the fewest columns that still hold n in that many rows. 9 plots with room for 8 give 5 + 4.
 */
export function balancedColumns(n: number, maxCols: number): number {
  const room = Math.max(1, Math.floor(maxCols));
  if (!(n > 0)) return room;
  const rows = Math.ceil(n / room);
  return Math.ceil(n / rows);
}
