// Property 20: the result headline states the counts and the grammar is right
// Validates: Requirements 6.15
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { resultHeadline, type HeadlineCounts } from '../web/result-headline.js';

const base: HeadlineCounts = { total: 9, dead: 0, possessed: 0, fixable: 0, restless: 0, failed: 0 };
const h = (o: Partial<HeadlineCounts>): string => resultHeadline({ ...base, ...o });

describe('resultHeadline', () => {
  it('states gone and fixable', () => {
    expect(h({ dead: 1, fixable: 1 })).toBe('1 of 9 links is gone. 1 can come back.');
    expect(h({ dead: 2, possessed: 1, fixable: 2 })).toBe('3 of 9 links are gone. 2 can come back.');
    expect(h({ dead: 1 })).toBe('1 of 9 links is gone. None can come back.');
    expect(h({ total: 1, dead: 1, fixable: 1 })).toBe('1 of 1 link is gone. 1 can come back.');
  });
  it('says everything is fine when nothing is gone', () => {
    expect(h({})).toBe('All 9 links still lead where they should.');
    expect(h({ total: 1 })).toBe('All 1 link still leads where it should.');
  });
  it('appends the restless count', () => {
    expect(h({ restless: 1 })).toBe('All 9 links still lead where they should. 1 could not be judged.');
    expect(h({ dead: 2, fixable: 1, restless: 3 })).toBe('2 of 9 links are gone. 1 can come back. 3 could not be judged.');
  });
  it('builds from the judged links when a batch failed', () => {
    expect(h({ total: 9, failed: 3, dead: 1, fixable: 1 })).toBe('6 of 9 links judged. 1 of 6 links is gone. 1 can come back.');
    expect(h({ total: 3, failed: 3 })).toBe('0 of 3 links judged.');
    expect(h({ total: 2, failed: 1 })).toBe('1 of 2 links judged. All 1 link still leads where it should.');
  });
});

const arbCounts = fc
  .record({
    alive: fc.integer({ min: 0, max: 60 }),
    dead: fc.integer({ min: 0, max: 60 }),
    possessed: fc.integer({ min: 0, max: 60 }),
    restless: fc.integer({ min: 0, max: 60 }),
    failed: fc.integer({ min: 0, max: 20 }),
    fixableShare: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map(r => {
    const judged = r.alive + r.dead + r.possessed + r.restless;
    const gone = r.dead + r.possessed;
    return { ...r, judged, gone, total: judged + r.failed, fixable: Math.floor(gone * r.fixableShare) };
  })
  .filter(r => r.total > 0);

describe('Property 20: the result headline states the counts and the grammar is right', () => {
  it('mentions the right counts and never says "1 links" or "1 are"', () => {
    fc.assert(
      fc.property(arbCounts, r => {
        const text = resultHeadline(r);
        // counts add up
        expect(r.gone + r.alive + r.restless).toBe(r.judged);
        expect(text).not.toMatch(/\b1 links\b/);
        expect(text).not.toMatch(/\b1 are\b/);
        expect(text).not.toMatch(/\b(?!1\b)\d+ is\b/);
        if (r.failed > 0) expect(text).toContain(`${r.judged} of ${r.total} ${r.total === 1 ? 'link' : 'links'} judged.`);
        if (r.judged === 0) return;
        if (r.gone > 0) {
          expect(text).toContain(`${r.gone} of ${r.judged} `);
          expect(text).toContain(r.fixable > 0 ? `${r.fixable} can come back.` : 'None can come back.');
        } else {
          expect(text).toContain(`All ${r.judged} `);
        }
        if (r.restless > 0) expect(text.endsWith(`${r.restless} could not be judged.`)).toBe(true);
        else expect(text).not.toContain('could not be judged');
      }),
      { numRuns: 200 },
    );
  });
});
