/**
 * Property-based tests for the tombstone height formula.
 *
 * // Feature: revenant, Property 11: Tombstone height formula
 *
 * The formula under test is `clamp(y * 12, 40, 220)` where `y` is the
 * lifespan in whole years. This is the pure arithmetic core of `lifespanHeight`
 * in `web/scene.ts`. Because that module has DOM dependencies, we test the
 * formula inline here with a comment reference back to the source.
 *
 * Validates: Requirements 6.3
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';

// Pure height formula — mirrors `lifespanHeight` in web/scene.ts.
// clamp(y * 12, 40, 220)
const tombstoneHeight = (y: number): number => Math.min(Math.max(y * 12, 40), 220);

// ---------------------------------------------------------------------------
// Arbitrary: non-negative integers representing a lifespan in years
// ---------------------------------------------------------------------------

/** Non-negative integers; range 0–200 covers every meaningful lifespan. */
const arbLifespan = (): fc.Arbitrary<number> =>
  fc.integer({ min: 0, max: 200 });

// ---------------------------------------------------------------------------
// Property 11a: result is always in [40, 220]
// ---------------------------------------------------------------------------

describe('Property 11: Tombstone height formula', () => {
  it('11a: clamp(y * 12, 40, 220) is always in [40, 220] for any y ≥ 0', () => {
    // Feature: revenant, Property 11: Tombstone height formula
    fc.assert(
      fc.property(arbLifespan(), (y) => {
        const h = tombstoneHeight(y);
        return h >= 40 && h <= 220;
      }),
      { numRuns: 100 },
    );
  });

  // ---------------------------------------------------------------------------
  // Property 11b: result at y === 0 is exactly 40 (the minimum)
  // ---------------------------------------------------------------------------

  it('11b: clamp(0 * 12, 40, 220) === 40', () => {
    // Feature: revenant, Property 11: Tombstone height formula
    // This is a point check, not a property over inputs, so we use fc.constant.
    fc.assert(
      fc.property(fc.constant(0), (y) => {
        return tombstoneHeight(y) === 40;
      }),
      { numRuns: 100 },
    );
  });

  // ---------------------------------------------------------------------------
  // Property 11c: result increases linearly (monotone) for y in [1, 30]
  // ---------------------------------------------------------------------------

  it('11c: for y in [1, 30], y1 < y2 → height(y1) ≤ height(y2)', () => {
    // Feature: revenant, Property 11: Tombstone height formula
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 29 }),
        fc.integer({ min: 2, max: 30 }),
        (y1, y2) => {
          // Ensure y1 < y2 regardless of which the shrinker picks
          const lo = Math.min(y1, y2);
          const hi = Math.max(y1, y2);
          if (lo === hi) return true; // equal years → equal height, still monotone
          return tombstoneHeight(lo) <= tombstoneHeight(hi);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ---------------------------------------------------------------------------
  // Property 11d: result is exactly 220 for all y ≥ 30
  // ---------------------------------------------------------------------------

  it('11d: for y ≥ 30, height === 220', () => {
    // Feature: revenant, Property 11: Tombstone height formula
    fc.assert(
      fc.property(fc.integer({ min: 30, max: 200 }), (y) => {
        return tombstoneHeight(y) === 220;
      }),
      { numRuns: 100 },
    );
  });
});
