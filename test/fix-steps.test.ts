import { describe, expect, it } from 'vitest';
import { patch } from '../src/core/patch.ts';
import type { Judgement } from '../src/core/types.ts';
import { COPY_FAILED_MESSAGE, copiedMessage, fixSteps, openOnGithubLabel, patchedDocument } from '../web/fix-steps.ts';

const source = 'See [a](https://dead.example/x) and [b](https://fine.example/y) and [c](https://dead.example/z).\n';

function dead(url: string, start: number): Judgement {
  return {
    link: { url, spans: [{ start, end: start + url.length }] },
    verdict: 'dead',
    reason: 'Gone.',
    resurrection: `https://web.archive.org/web/2016id_/${url}`,
  } as unknown as Judgement;
}

describe('patchedDocument', () => {
  const judgements: Array<Judgement | undefined> = [
    dead('https://dead.example/x', source.indexOf('https://dead.example/x')),
    undefined,
    dead('https://dead.example/z', source.indexOf('https://dead.example/z')),
  ];

  it('is exactly what core patch gives, so Copy and Download are byte-identical', () => {
    const excluded = new Set<string>();
    const list = judgements.filter((j): j is Judgement => j !== undefined);
    const copy = patchedDocument(source, judgements, excluded);
    const download = patchedDocument(source, judgements, excluded);
    expect(Buffer.from(copy, 'utf-8').equals(Buffer.from(download, 'utf-8'))).toBe(true);
    expect(copy).toBe(patch(source, list, excluded));
    expect(copy).not.toBe(source);
  });

  it('honours the excluded set', () => {
    const copy = patchedDocument(source, judgements, new Set(['https://dead.example/x']));
    expect(copy).toContain('https://dead.example/x');
    expect(copy).not.toContain('(https://dead.example/z)');
  });
});

describe('fix steps and messages', () => {
  it('has three steps when the GitHub link is shown', () => {
    expect(fixSteps(true)).toEqual([
      'Copy the patched document.',
      'Open the README on GitHub.',
      'Paste it and propose the change.',
    ]);
  });

  it('has two steps otherwise, with no GitHub mention', () => {
    const steps = fixSteps(false);
    expect(steps).toEqual(['Copy or download the patched document.', 'Replace the original with it.']);
    expect(steps.join(' ')).not.toMatch(/GitHub/);
  });

  it('uses singular and plural forms', () => {
    expect(copiedMessage(1)).toBe('Patched document copied: 1 link changed.');
    expect(copiedMessage(0)).toBe('Patched document copied: 0 links changed.');
    expect(copiedMessage(12)).toBe('Patched document copied: 12 links changed.');
  });

  it('names the file and the failure', () => {
    expect(openOnGithubLabel('docs/README.md')).toBe('Open docs/README.md on GitHub');
    expect(COPY_FAILED_MESSAGE).toMatch(/Ctrl\+C/);
  });
});
