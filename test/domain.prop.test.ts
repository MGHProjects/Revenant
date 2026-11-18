/**
 * Property tests for registrableDomain.
 *
 * Feature: revenant, Property: registrable-domain invariants
 *
 * Validates: Requirements 2.5, 2.8
 */
import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { registrableDomain } from '../src/core/domain.ts';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** A single DNS label: 1–10 lowercase alphanumeric characters (no hyphens to
 *  keep the generator simple). */
const arbLabel = fc.stringMatching(/^[a-z]{1,10}$/).filter(s => s.length > 0);

/** A hostname with 1–5 labels joined by dots. */
const arbHostname = fc
  .array(arbLabel, { minLength: 1, maxLength: 5 })
  .map(labels => labels.join('.'));

/** One of the recognised two-level effective TLDs. */
const TWO_LEVEL_TLDS = ['co.uk', 'com.au', 'org.uk', 'net.au', 'co.nz', 'org.nz', 'com.br', 'co.jp'] as const;
const arbTwoLevelTld = fc.constantFrom(...TWO_LEVEL_TLDS);

/** A hostname whose TLD is a known two-level TLD, with 1–3 labels in front. */
const arbTwoLevelHostname = fc
  .tuple(fc.array(arbLabel, { minLength: 1, maxLength: 3 }), arbTwoLevelTld)
  .map(([labels, tld]) => `${labels.join('.')}.${tld}`);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('registrableDomain — property tests', () => {
  it('always returns a non-empty string', () => {
    // Property: output is never empty.
    fc.assert(
      fc.property(arbHostname, hostname => {
        const result = registrableDomain(hostname);
        return result.length > 0;
      }),
      { numRuns: 100 },
    );
  });

  it('result is always a suffix of the (lowercased) input', () => {
    // Property: registrableDomain(h) is always a label-aligned suffix of h.
    fc.assert(
      fc.property(arbHostname, hostname => {
        const result = registrableDomain(hostname);
        const lower = hostname.toLowerCase();
        return lower === result || lower.endsWith('.' + result);
      }),
      { numRuns: 100 },
    );
  });

  it('result has at most 3 labels', () => {
    // Property: the registrable domain never exceeds three dot-separated labels.
    fc.assert(
      fc.property(arbHostname, hostname => {
        const result = registrableDomain(hostname);
        return result.split('.').length <= 3;
      }),
      { numRuns: 100 },
    );
  });

  it('result has at least 1 label', () => {
    fc.assert(
      fc.property(arbHostname, hostname => {
        const result = registrableDomain(hostname);
        return result.split('.').length >= 1;
      }),
      { numRuns: 100 },
    );
  });

  it('is idempotent: applying it twice returns the same value', () => {
    // Property: registrableDomain(registrableDomain(h)) === registrableDomain(h)
    fc.assert(
      fc.property(arbHostname, hostname => {
        const once = registrableDomain(hostname);
        const twice = registrableDomain(once);
        return once === twice;
      }),
      { numRuns: 100 },
    );
  });

  it('two-level TLD hostnames always produce a 3-label result', () => {
    // Property: for any hostname of the form "<label(s)>.<two-level-tld>",
    // the result has exactly 3 labels.
    fc.assert(
      fc.property(arbTwoLevelHostname, hostname => {
        const result = registrableDomain(hostname);
        return result.split('.').length === 3;
      }),
      { numRuns: 100 },
    );
  });

  it('two-level TLD hostnames keep their effective TLD intact in the result', () => {
    // Property: the two-level effective TLD appears at the end of the result.
    fc.assert(
      fc.property(arbTwoLevelHostname, hostname => {
        const result = registrableDomain(hostname);
        const tld = TWO_LEVEL_TLDS.find(t => hostname.endsWith('.' + t)) ?? '';
        return result.endsWith('.' + tld);
      }),
      { numRuns: 100 },
    );
  });

  it('adding a subdomain prefix does not change the registrable domain', () => {
    // Property: prepending an extra label before the registrable domain
    // of a hostname does not change the result.
    fc.assert(
      fc.property(
        arbHostname.filter(h => h.split('.').length >= 2),
        arbLabel,
        (hostname, prefix) => {
          const base = registrableDomain(hostname);
          const withPrefix = `${prefix}.${hostname}`;
          const result = registrableDomain(withPrefix);
          return result === base;
        },
      ),
      { numRuns: 100 },
    );
  });
});
