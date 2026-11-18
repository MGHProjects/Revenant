import { describe, it, expect } from 'vitest';
import { patch } from '../src/core/patch.js';
import type { Judgement, Link } from '../src/core/types.js';

// Helper to build a Judgement with minimal boilerplate.
function makeJudgement(
  url: string,
  spans: Array<{ start: number; end: number }>,
  verdict: Judgement['verdict'],
  resurrection?: string,
): Judgement {
  const link: Link = { url, spans };
  return { link, verdict, reason: 'test', resurrection };
}

describe('patch', () => {
  it('replaces a single dead link with its resurrection URL', () => {
    const source = 'See https://example.com for details.';
    //                   ^5                  ^24
    const j = makeJudgement('https://example.com', [{ start: 4, end: 23 }], 'dead', 'https://web.archive.org/web/20200101000000/https://example.com');
    const result = patch(source, [j], new Set());
    expect(result).toBe('See https://web.archive.org/web/20200101000000/https://example.com for details.');
  });

  it('replaces a single possessed link with its resurrection URL', () => {
    const source = '[ref](https://hijacked.example)';
    //                    ^6                      ^30
    const resurrection = 'https://web.archive.org/web/20190601000000/https://hijacked.example';
    const j = makeJudgement('https://hijacked.example', [{ start: 6, end: 30 }], 'possessed', resurrection);
    const result = patch(source, [j], new Set());
    expect(result).toBe(`[ref](${resurrection})`);
  });

  it('replaces multiple dead links in correct order without offset corruption', () => {
    // Three links at known positions:
    //   "aa BB cc DD ee FF ff"
    //      ^3  ^5   ^9  ^11  ^15 ^17
    const source = 'aa https://b.com cc https://d.com ee https://f.com';
    // Compute exact spans:
    //   https://b.com  starts at 3, ends at 16
    //   https://d.com  starts at 20, ends at 33
    //   https://f.com  starts at 37, ends at 50
    const jB = makeJudgement('https://b.com', [{ start: 3, end: 16 }], 'dead', 'https://archive.org/B');
    const jD = makeJudgement('https://d.com', [{ start: 20, end: 33 }], 'dead', 'https://archive.org/D');
    const jF = makeJudgement('https://f.com', [{ start: 37, end: 50 }], 'dead', 'https://archive.org/F');
    const result = patch(source, [jB, jD, jF], new Set());
    expect(result).toBe('aa https://archive.org/B cc https://archive.org/D ee https://archive.org/F');
  });

  it('leaves excluded dead and possessed links unchanged', () => {
    const source = 'Visit https://dead.example and https://possessed.example please.';
    const jDead = makeJudgement('https://dead.example', [{ start: 6, end: 26 }], 'dead', 'https://archive.org/dead');
    const jPossessed = makeJudgement('https://possessed.example', [{ start: 31, end: 56 }], 'possessed', 'https://archive.org/possessed');
    const excluded = new Set(['https://dead.example', 'https://possessed.example']);
    const result = patch(source, [jDead, jPossessed], excluded);
    expect(result).toBe(source);
  });

  it('leaves source unchanged when there are no dead or possessed links', () => {
    const source = 'Check https://alive.example and https://restless.example.';
    const jAlive = makeJudgement('https://alive.example', [{ start: 6, end: 27 }], 'alive');
    const jRestless = makeJudgement('https://restless.example', [{ start: 32, end: 56 }], 'restless');
    const result = patch(source, [jAlive, jRestless], new Set());
    expect(result).toBe(source);
  });

  it('leaves dead/possessed links with no resurrection unchanged', () => {
    const source = 'Gone: https://lost.example forever.';
    const j = makeJudgement('https://lost.example', [{ start: 6, end: 26 }], 'dead'); // no resurrection
    const result = patch(source, [j], new Set());
    expect(result).toBe(source);
  });

  it('applies adjacent replacements correctly without offset corruption', () => {
    // Two links back-to-back separated by a single space:
    //   "https://a.example https://b.example"
    //    ^0              ^18 ^19             ^37
    const source = 'https://a.example https://b.example';
    const jA = makeJudgement('https://a.example', [{ start: 0, end: 17 }], 'dead', 'https://archive.org/A');
    const jB = makeJudgement('https://b.example', [{ start: 18, end: 35 }], 'dead', 'https://archive.org/B');
    const result = patch(source, [jA, jB], new Set());
    expect(result).toBe('https://archive.org/A https://archive.org/B');
  });

  it('replaces only the unexcluded link when one of two dead links is excluded', () => {
    const source = 'A: https://dead1.example B: https://dead2.example';
    const j1 = makeJudgement('https://dead1.example', [{ start: 3, end: 24 }], 'dead', 'https://archive.org/1');
    const j2 = makeJudgement('https://dead2.example', [{ start: 28, end: 49 }], 'dead', 'https://archive.org/2');
    const excluded = new Set(['https://dead1.example']);
    const result = patch(source, [j1, j2], excluded);
    expect(result).toBe('A: https://dead1.example B: https://archive.org/2');
  });

  it('handles a URL that appears at multiple spans', () => {
    // Same URL appears twice; both spans should be replaced.
    const source = 'First https://dup.example second https://dup.example end';
    //              0     ^6                ^26 ^27    ^33                ^53
    const j = makeJudgement(
      'https://dup.example',
      [{ start: 6, end: 25 }, { start: 33, end: 52 }],
      'dead',
      'https://archive.org/dup',
    );
    const result = patch(source, [j], new Set());
    expect(result).toBe('First https://archive.org/dup second https://archive.org/dup end');
  });
});
