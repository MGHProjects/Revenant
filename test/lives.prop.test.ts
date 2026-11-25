// Property 12: The chosen life is the longest continuous one
// Feature: revenant, Property 12: Chosen life is the longest continuous life
// **Validates: Requirements 3.1, 3.2**

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { chooseLife } from '../src/core/lives.js';
import type { Capture } from '../src/core/types.js';

const month = (ts: string): number => Number(ts.slice(0, 4)) * 12 + Number(ts.slice(4, 6));

/** Reference splitter, written independently of the implementation. */
function splitLives(captures: Capture[]): Capture[][] {
  const sorted = [...captures].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const lives: Capture[][] = [];
  for (const c of sorted) {
    const cur = lives[lives.length - 1];
    if (cur && month(c.timestamp) - month(cur[cur.length - 1]!.timestamp) <= 12) cur.push(c);
    else lives.push([c]);
  }
  return lives;
}

const span = (life: Capture[]): number => month(life[life.length - 1]!.timestamp) - month(life[0]!.timestamp);

const timestamp = fc
  .record({
    y: fc.integer({ min: 1996, max: 2026 }),
    m: fc.integer({ min: 1, max: 12 }),
    d: fc.integer({ min: 1, max: 28 }),
    t: fc.integer({ min: 0, max: 235959 }),
  })
  .map(({ y, m, d, t }) => `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}${String(t).padStart(6, '0')}`);

const capture = fc.record({
  timestamp,
  length: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: undefined }),
});

const captures = fc.array(capture, { minLength: 1, maxLength: 60 });

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

describe('Property 12: chosen life', () => {
  it('returns undefined only for empty input', () => {
    expect(chooseLife([])).toBeUndefined();
  });

  it('the chosen range comes from the input, first <= last, and is one contiguous life', () => {
    fc.assert(
      fc.property(captures, (caps) => {
        const r = chooseLife(caps)!;
        const stamps = new Set(caps.map((c) => c.timestamp));
        expect(stamps.has(r.first)).toBe(true);
        expect(stamps.has(r.last)).toBe(true);
        expect(r.first <= r.last).toBe(true);
        const life = splitLives(caps).find((l) => l[0]!.timestamp === r.first)!;
        expect(life).toBeDefined();
        expect(life.some((c) => c.timestamp === r.last)).toBe(true);
        for (let i = 1; i < life.length; i++) {
          expect(month(life[i]!.timestamp) - month(life[i - 1]!.timestamp)).toBeLessThanOrEqual(12);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('the chosen life spans at least as long as every other life; ties go to the earliest', () => {
    fc.assert(
      fc.property(captures, (caps) => {
        const r = chooseLife(caps)!;
        const lives = splitLives(caps);
        const idx = lives.findIndex((l) => l[0]!.timestamp === r.first);
        const chosenSpan = span(lives[idx]!);
        lives.forEach((l, i) => {
          expect(chosenSpan).toBeGreaterThanOrEqual(span(l));
          if (i < idx) expect(span(l)).toBeLessThan(chosenSpan);
        });
      }),
      { numRuns: 200 },
    );
  });

  it('first and last are the life\'s first and last captures; first <= copy <= last', () => {
    fc.assert(
      fc.property(captures, (caps) => {
        const r = chooseLife(caps)!;
        const life = splitLives(caps).find((l) => l[0]!.timestamp === r.first)!;
        expect(r.last).toBe(life[life.length - 1]!.timestamp);
        expect(life.some((c) => c.timestamp === r.copy)).toBe(true);
        expect(r.first <= r.copy && r.copy <= r.last).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('a one-capture life returns itself as first, last and copy', () => {
    fc.assert(
      fc.property(capture, (c) => {
        expect(chooseLife([c])).toEqual({ first: c.timestamp, last: c.timestamp, copy: c.timestamp });
      }),
      { numRuns: 100 },
    );
  });

  it('margin <= 12 and <= span/4; copy month <= cutoff month; copy is the last candidate with length >= median/2, else the last candidate', () => {
    fc.assert(
      fc.property(captures, (caps) => {
        const r = chooseLife(caps)!;
        const life = splitLives(caps).find((l) => l[0]!.timestamp === r.first)!;
        const margin = Math.min(12, Math.floor(span(life) / 4));
        expect(margin).toBeLessThanOrEqual(12);
        expect(margin).toBeLessThanOrEqual(span(life) / 4);
        const cutoff = month(r.last) - margin;
        expect(month(r.copy)).toBeLessThanOrEqual(cutoff);
        const candidates = life.filter((c) => month(c.timestamp) <= cutoff);
        const known = candidates.flatMap((c) => (c.length === undefined ? [] : [c.length]));
        const lastCandidate = candidates[candidates.length - 1]!.timestamp;
        if (known.length === 0) {
          expect(r.copy).toBe(lastCandidate);
          return;
        }
        const threshold = median(known) / 2;
        const qualifying = candidates.filter((c) => c.length !== undefined && c.length >= threshold);
        expect(r.copy).toBe(qualifying.length === 0 ? lastCandidate : qualifying[qualifying.length - 1]!.timestamp);
      }),
      { numRuns: 200 },
    );
  });
  it('input order does not matter (sorted inside)', () => {
    fc.assert(
      fc.property(captures, fc.nat(), (caps, seed) => {
        // equal timestamps with different lengths would make the order observable; keep them unique
        const unique = [...new Map(caps.map((c) => [c.timestamp, c])).values()];
        const rotated = unique.slice(seed % unique.length).concat(unique.slice(0, seed % unique.length));
        expect(chooseLife(rotated)).toEqual(chooseLife(unique));
        expect(chooseLife([...unique].reverse())).toEqual(chooseLife(unique));
      }),
      { numRuns: 200 },
    );
  });
});
