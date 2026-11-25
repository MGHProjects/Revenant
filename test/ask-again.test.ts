import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { canAskAgain, chunk, mergeJudgement, retryIndexes } from '../web/ask-again.js';
import type { Judgement, Verdict } from '../src/core/types.js';

const VERDICTS: Verdict[] = ['alive', 'dead', 'possessed', 'restless'];
const j = (url: string, verdict: Verdict, flag = false): Judgement => ({
  link: { url, spans: [{ start: 1, end: 2 }] },
  verdict,
  reason: 'r',
  ...(flag ? { archiveUnavailable: true as const } : {}),
});

describe('canAskAgain', () => {
  it('restless always; dead and possessed only when flagged; alive never', () => {
    expect(canAskAgain({ verdict: 'restless' })).toBe(true);
    expect(canAskAgain({ verdict: 'dead' })).toBe(false);
    expect(canAskAgain({ verdict: 'dead', archiveUnavailable: true })).toBe(true);
    expect(canAskAgain({ verdict: 'possessed', archiveUnavailable: true })).toBe(true);
    expect(canAskAgain({ verdict: 'alive' })).toBe(false);
  });
});

describe('retryIndexes', () => {
  it('takes only flagged links, including flagged restless, never unflagged restless', () => {
    const list = [j('a', 'dead', true), j('b', 'restless'), undefined, j('c', 'restless', true), j('d', 'alive')];
    expect(retryIndexes(list)).toEqual([0, 3]);
  });
});

describe('chunk', () => {
  it('splits in batches of 3', () => {
    expect(chunk([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });
});

describe('mergeJudgement', () => {
  it('replaces one entry, keeps order, spans and the user\'s Patch choice', () => {
    const list = [j('a', 'alive'), j('b', 'dead', true), j('c', 'alive')];
    const fresh: Judgement = { link: { url: 'b', spans: [] }, verdict: 'dead', reason: 'r2', resurrection: 'https://web.archive.org/x' };
    const out = mergeJudgement(list, 1, fresh, new Set(['b']));
    expect(out.judgements.map(x => x?.link.url)).toEqual(['a', 'b', 'c']);
    expect(out.judgements[1]!.reason).toBe('r2');
    expect(out.judgements[1]!.link.spans).toEqual([{ start: 1, end: 2 }]);
    expect(out.excluded.has('b')).toBe(true);
    expect(list[1]!.reason).toBe('r');
  });

  it('a link with no earlier choice stays checked (not excluded)', () => {
    const out = mergeJudgement([j('a', 'restless')], 0, j('a', 'dead'), new Set());
    expect(out.excluded.size).toBe(0);
  });
});

// Property 14: Ask again replaces one judgement and nothing else
describe('Property 14: Ask again replaces one judgement and nothing else', () => {
  // **Validates: Requirements 3, 6**
  it('keeps length, order and every other entry', () => {
    const arb = fc.record({
      verdicts: fc.array(fc.constantFrom(...VERDICTS), { minLength: 1, maxLength: 20 }),
      pick: fc.nat(),
      next: fc.constantFrom(...VERDICTS),
      excluded: fc.array(fc.nat(19), { maxLength: 5 }),
    });
    fc.assert(fc.property(arb, ({ verdicts, pick, next, excluded }) => {
      const list = verdicts.map((v, i) => j(`u${i}`, v));
      const at = pick % list.length;
      const ex = new Set(excluded.map(n => `u${n}`));
      const out = mergeJudgement(list, at, j(`u${at}`, next), ex);
      expect(out.judgements).toHaveLength(list.length);
      out.judgements.forEach((x, i) => {
        expect(x!.link.url).toBe(`u${i}`);
        if (i !== at) expect(x).toBe(list[i]);
      });
      expect(out.judgements[at]!.verdict).toBe(next);
      expect([...out.excluded].sort()).toEqual([...ex].sort());
    }));
  });
});