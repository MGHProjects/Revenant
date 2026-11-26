import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mistOpacity } from '../web/mist.js';

describe('mistOpacity', () => {
  it.each([
    [9, 0, 0, 1],
    [9, 3, 0, 0.67],
    [9, 9, 2, 0.22],
    [0, 0, 0, 1],
  ])('(%i, %i, %i) gives %f', (total, judged, restless, want) => {
    expect(mistOpacity(total, judged, restless)).toBe(want);
  });
});

// Property 17: mist opacity stays in [0, 1], falls as links are judged and rises with restless links
describe('Property 17: mist opacity', () => {
  /** **Validates: Requirements 6.1, 6.7** */
  it('is in [0, 1], non-increasing in judged and non-decreasing in restless', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        (total, a, b, r, s) => {
          const [j1, j2] = [Math.min(a, b, total), Math.min(Math.max(a, b), total)];
          const [r1, r2] = [Math.min(r, s), Math.max(r, s)];
          for (const v of [mistOpacity(total, j1, r1), mistOpacity(total, j2, r2)]) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
          expect(mistOpacity(total, j2, r1)).toBeLessThanOrEqual(mistOpacity(total, j1, r1));
          expect(mistOpacity(total, j1, r2)).toBeGreaterThanOrEqual(mistOpacity(total, j1, r1));
        },
      ),
    );
  });
});
