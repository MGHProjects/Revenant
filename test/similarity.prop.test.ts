// Feature: revenant, Property 5: Similarity is a proper measure

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { similarity } from '#core';

/**
 * Validates: Requirements 2.5
 *
 * Property 5: Similarity is a proper measure
 *   5a. similarity(a, b) is always in [0, 1]
 *   5b. similarity(a, a) === 1 for any non-empty string with at least 3 words
 *   5c. similarity(a, b) === similarity(b, a)  (symmetry)
 */

/** Arbitrary that produces a string with at least 3 space-separated word tokens. */
const threeWordString = fc
  .array(fc.stringMatching(/^[a-z]+$/), { minLength: 3, maxLength: 20 })
  .map((words) => words.join(' '));

describe('Property 5: Similarity is a proper measure', () => {
  it('5a: result is always in [0, 1]', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const s = similarity(a, b);
        return s >= 0 && s <= 1;
      }),
      { numRuns: 100 },
    );
  });

  it('5b: similarity(a, a) === 1 for any string with at least 3 words', () => {
    fc.assert(
      fc.property(threeWordString, (a) => {
        return similarity(a, a) === 1;
      }),
      { numRuns: 100 },
    );
  });

  it('5c: symmetry — similarity(a, b) === similarity(b, a)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        return similarity(a, b) === similarity(b, a);
      }),
      { numRuns: 100 },
    );
  });
});
