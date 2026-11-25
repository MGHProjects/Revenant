/**
 * Property-based tests for the yard column math.
 *
 * // Property 13: Yard columns are balanced
 *
 * Validates: Requirements 6.1, 6.2
 */

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { balancedColumns, maxColumns } from '../web/yard-columns.js';

const rowsOf = (n: number, cols: number): number[] => {
  const rows: number[] = [];
  for (let left = n; left > 0; left -= cols) rows.push(Math.min(cols, left));
  return rows;
};

const arbN = fc.integer({ min: 1, max: 200 });
const arbMax = fc.integer({ min: 1, max: 24 });

describe('Property 13: Yard columns are balanced', () => {
  it('13a: cols <= maxCols and cols x rows >= n', () => {
    fc.assert(
      fc.property(arbN, arbMax, (n, max) => {
        const cols = balancedColumns(n, max);
        return cols >= 1 && cols <= max && cols * Math.ceil(n / cols) >= n;
      }),
      { numRuns: 100 },
    );
  });

  it('13b: never more rows than the widest layout needs', () => {
    fc.assert(
      fc.property(arbN, arbMax, (n, max) => {
        const cols = balancedColumns(n, max);
        return rowsOf(n, cols).length === Math.ceil(n / max);
      }),
      { numRuns: 100 },
    );
  });

  it('13c: no orphan row: the last row is short by fewer plots than there are rows', () => {
    fc.assert(
      fc.property(arbN, arbMax, (n, max) => {
        const cols = balancedColumns(n, max);
        const rows = rowsOf(n, cols);
        return cols - rows[rows.length - 1]! < rows.length;
      }),
      { numRuns: 100 },
    );
  });

  it('13d: with at most two rows, rows differ by at most 1 plot', () => {
    fc.assert(
      fc.property(arbN, arbMax, (n, max) => {
        fc.pre(Math.ceil(n / max) <= 2);
        const rows = rowsOf(n, balancedColumns(n, max));
        return Math.max(...rows) - Math.min(...rows) <= 1;
      }),
      { numRuns: 100 },
    );
  });

  it('examples from the review', () => {
    expect(rowsOf(9, balancedColumns(9, 8))).toEqual([5, 4]);
    expect(rowsOf(9, balancedColumns(9, 3))).toEqual([3, 3, 3]);
    expect(rowsOf(10, balancedColumns(10, 8))).toEqual([5, 5]);
    expect(rowsOf(7, balancedColumns(7, 8))).toEqual([7]);
  });

  it('maxColumns: 112 px per column, 3 when narrow, never below 1', () => {
    expect(maxColumns(900, false)).toBe(8);
    expect(maxColumns(50, false)).toBe(1);
    expect(maxColumns(1200, true)).toBe(3);
  });
});
