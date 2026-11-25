// Property 16: host parts join back to the host
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { hostParts } from '../web/host-parts.js';

describe('hostParts', () => {
  it('keeps a single label whole', () => {
    expect(hostParts('localhost')).toEqual(['localhost']);
  });
  it('keeps each dot with the part before it', () => {
    expect(hostParts('paulgraham.com')).toEqual(['paulgraham.', 'com']);
    expect(hostParts('a.b.example.co.uk')).toEqual(['a.', 'b.', 'example.', 'co.', 'uk']);
  });
  it('splits punycode like any other label', () => {
    expect(hostParts('xn--bcher-kva.example')).toEqual(['xn--bcher-kva.', 'example']);
  });
  it('handles a trailing dot and the empty host', () => {
    expect(hostParts('example.com.')).toEqual(['example.', 'com.']);
    expect(hostParts('')).toEqual([]);
  });
  it('joins back to the host', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom('a', 'b', '-', '.', 'é', '1') }), (h) => {
        expect(hostParts(h).join('')).toBe(h);
      }),
    );
  });
});
