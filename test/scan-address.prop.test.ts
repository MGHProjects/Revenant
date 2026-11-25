// Property 15: a graveyard's address round-trips and never carries a document
// Validates: Requirements 1.3, 6.1
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseScanParams, searchAfterScan } from '../web/scan-address.js';

const name = fc.stringMatching(/^[A-Za-z0-9_.-]{1,20}$/);
const slug = fc.tuple(name, name).map(([a, b]) => `${a}/${b}`);
const pageUrl = fc
  .tuple(fc.constantFrom('http', 'https'), fc.constantFrom('example.org', 'info.cern.ch', 'a.b.co.uk'), fc.stringMatching(/^[A-Za-z0-9/_.~%-]{0,20}$/))
  .map(([s, h, p]) => `${s}://${h}/${p}`);
const unrelated = fc.uniqueArray(
  fc.tuple(fc.stringMatching(/^[a-z]{1,6}$/).filter(k => !['sample', 'repo', 'url'].includes(k)), fc.string({ maxLength: 8 })),
  { selector: ([k]) => k, maxLength: 4 },
);
const qs = (pairs: Array<[string, string]>): string => {
  const p = new URLSearchParams(pairs);
  return p.size ? `?${p.toString()}` : '';
};

describe('parseScanParams', () => {
  it('accepts a valid repo and url', () => {
    expect(parseScanParams('?repo=sindresorhus/awesome')).toEqual({ kind: 'repo', value: 'sindresorhus/awesome' });
    expect(parseScanParams('?url=http%3A%2F%2Finfo.cern.ch%2Fhypertext%2FWWW%2FTheProject.html')).toEqual({
      kind: 'url',
      value: 'http://info.cern.ch/hypertext/WWW/TheProject.html',
    });
    expect(parseScanParams('')).toEqual({ kind: 'none' });
    expect(parseScanParams('?sample=1')).toEqual({ kind: 'sample' });
  });

  it('rejects invalid repo and url values', () => {
    for (const s of ['?repo=nope', '?repo=a/b/c', '?repo=', '?repo=a%20b/c', '?url=ftp://x.org/', '?url=javascript:alert(1)',
      '?url=https://user:pw@example.org/', '?url=http://localhost/', '?url=http://127.0.0.1/', '?url=notaurl', '?url=']) {
      expect(parseScanParams(s).kind, s).toBe('invalid');
    }
  });

  it('applies precedence sample > repo > url, and an invalid first value does not fall through', () => {
    expect(parseScanParams('?url=https://example.org/&repo=a/b&sample=1').kind).toBe('sample');
    expect(parseScanParams('?url=https://example.org/&repo=a/b')).toEqual({ kind: 'repo', value: 'a/b' });
    expect(parseScanParams('?repo=bad&url=https://example.org/').kind).toBe('invalid');
    expect(parseScanParams('?sample=0&url=https://example.org/').kind).toBe('url');
  });
});

describe('searchAfterScan', () => {
  it('writes sample, repo and url and drops the other scan parameters', () => {
    expect(searchAfterScan('?repo=a/b&utm=1', { kind: 'sample' })).toEqual({ search: '?utm=1&sample=1', shareable: true });
    expect(searchAfterScan('?sample=1', { kind: 'address', address: 'a/b' })).toEqual({ search: '?repo=a%2Fb', shareable: true });
    expect(searchAfterScan('?repo=a/b&sample=1', { kind: 'address', address: 'https://example.org/x?y=1' }).search)
      .toBe('?url=https%3A%2F%2Fexample.org%2Fx%3Fy%3D1');
  });

  it('leaves the bar alone for an address a link cannot carry', () => {
    expect(searchAfterScan('?repo=a/b', { kind: 'address', address: 'nonsense' })).toEqual({ search: '?repo=a/b', shareable: false });
  });

  it('a textarea scan clears scan parameters, keeps others, and is not shareable', () => {
    expect(searchAfterScan('?repo=a/b&url=https://example.org/&sample=1&x=2', { kind: 'text' })).toEqual({ search: '?x=2', shareable: false });
    expect(searchAfterScan('?repo=a/b', { kind: 'text' })).toEqual({ search: '', shareable: false });
    expect(searchAfterScan('?x=2', { kind: 'text' }).search).toBe('?x=2');
  });

  it('url is encoded and round-trips; unrelated parameters are kept', () => {
    fc.assert(
      fc.property(pageUrl, unrelated, (u, other) => {
        const { search } = searchAfterScan(qs(other), { kind: 'address', address: u });
        expect(parseScanParams(search)).toEqual({ kind: 'url', value: u });
        const back = new URLSearchParams(search);
        for (const [k, v] of other) expect(back.get(k)).toBe(v);
      }),
      { numRuns: 100 },
    );
  });

  it('repo round-trips', () => {
    fc.assert(
      fc.property(slug, unrelated, (s, other) => {
        const { search } = searchAfterScan(qs(other), { kind: 'address', address: s });
        expect(parseScanParams(search)).toEqual({ kind: 'repo', value: s });
      }),
      { numRuns: 100 },
    );
  });

  it('a textarea scan never puts the document in the URL', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), unrelated, (doc, other) => {
        const { search, shareable } = searchAfterScan(qs(other), { kind: 'text' });
        expect(shareable).toBe(false);
        expect(search).toBe(qs(other));
        expect(doc).toBeTypeOf('string'); // the document is not an input of searchAfterScan at all
      }),
      { numRuns: 100 },
    );
  });
});
