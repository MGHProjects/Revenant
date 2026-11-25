/**
 * Property-based tests for the tombstone height formula.
 *
 * // Feature: revenant, Property 11: Tombstone height formula
 *
 * The formula under test is `clamp(y * 8, 64, 176)` where `y` is the
 * lifespan in whole years: the real `lifespanHeight` exported by `web/scene.ts`
 * (that module has no top-level DOM access, so it imports cleanly here).
 *
 * Validates: Requirements 6.3
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { lifespanHeight } from '../web/scene.js';

// Property 11 runs the real `lifespanHeight`: an epitaph spanning y whole years.
const tombstoneHeight = (y: number): number =>
  lifespanHeight({ first: '2000-01-01', last: `${2000 + y}-12-31`, copy: `${2000 + y}-12-31` });

/** Non-negative integers; range 0–200 covers every meaningful lifespan. */
const arbLifespan = (): fc.Arbitrary<number> =>
  fc.integer({ min: 0, max: 200 });

describe('Property 11: Tombstone height formula', () => {
  it('11a: height is always in [64, 176] for any y ≥ 0', () => {
    // Feature: revenant, Property 11: Tombstone height formula
    fc.assert(
      fc.property(arbLifespan(), (y) => {
        const h = tombstoneHeight(y);
        return h >= 64 && h <= 176;
      }),
      { numRuns: 100 },
    );
  });

  it('11b: height is the minimum 64 for any y ≤ 8', () => {
    // Feature: revenant, Property 11: Tombstone height formula
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8 }), (y) => tombstoneHeight(y) === 64),
      { numRuns: 100 },
    );
  });

  it('11c: for y in [8, 22], height is exactly y * 8 (linear)', () => {
    // Feature: revenant, Property 11: Tombstone height formula
    fc.assert(
      fc.property(fc.integer({ min: 8, max: 22 }), (y) => tombstoneHeight(y) === y * 8),
      { numRuns: 100 },
    );
  });

  it('11d: for y ≥ 22, height is the maximum 176', () => {
    // Feature: revenant, Property 11: Tombstone height formula
    fc.assert(
      fc.property(fc.integer({ min: 22, max: 200 }), (y) => tombstoneHeight(y) === 176),
      { numRuns: 100 },
    );
  });

  it('11e: no dates ("none", "unavailable" or missing) gives 64', () => {
    // Feature: revenant, Property 11: Tombstone height formula
    if (lifespanHeight() !== 64 || lifespanHeight('none') !== 64 || lifespanHeight('unavailable') !== 64) {
      throw new Error('expected 64');
    }
  });
});
