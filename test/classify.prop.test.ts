// Feature: revenant, Property 6: Never cry wolf

/**
 * Validates: Requirements 2.2, 2.3, 2.4, 2.8, 2.9
 *
 * Property 6: Never cry wolf
 *   6a. For any Probe with status 401, 403, or 429, classify never returns `dead`.
 *   6b. For any Probe with outcome === 'timeout', classify never returns `dead`.
 *   6c. For any Probe with status 5xx (the after-retry path), classify returns `restless`.
 *   6d. For any Probe whose finalUrl shares the same registrable domain as originalUrl,
 *       classify never returns `possessed`.
 *   6f. For any Probe with outcome === 'network-error' and no dnsFailure, classify never returns `dead`.
 *   6g. For a cross-domain 2xx whose archive lookup was 'unavailable', classify never returns
 *       `alive` or `dead` (it is `restless`).
 *   6h. The same name under another public suffix is never possessed.
 *   6i. A known rename is never possessed.
 *   6j. A live text under the threshold is never possessed.
 *   6e. Every result has exactly one verdict and a non-empty reason.
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { classify, MIN_LIVE_TEXT_CHARS } from '../src/core/classify.ts';
import { KNOWN_RENAMES } from '../src/core/known-renames.ts';
import { registrableDomain } from '../src/core/domain.ts';
import type { Probe, SnapshotResult } from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Arbitrary HTTP status code — covers 1xx through 5xx. */
const arbStatus = fc.integer({ min: 100, max: 599 });

/** Arbitrary probe text (live page body). */
const arbText = fc.oneof(fc.constant(undefined), fc.string());

/** Arbitrary valid-looking URL with http or https scheme. */
const arbHttpUrl = fc
  .tuple(
    fc.constantFrom('http', 'https'),
    fc.stringMatching(/^[a-z]{3,10}$/),
    fc.stringMatching(/^[a-z]{2,6}$/),
  )
  .map(([scheme, name, tld]) => `${scheme}://${name}.${tld}/page`);

/**
 * arbProbe() — produces Probe objects spanning all outcome and status combinations:
 *   - outcome 'timeout' (no status)
 *   - outcome 'network-error' (no status)
 *   - outcome 'response' with any HTTP status (100–599)
 */
function arbProbe(): fc.Arbitrary<Probe> {
  const timeoutProbe: fc.Arbitrary<Probe> = fc.record({
    outcome: fc.constant('timeout' as const),
    text: arbText,
  });

  const networkErrorProbe: fc.Arbitrary<Probe> = fc.record({
    outcome: fc.constant('network-error' as const),
    text: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1 })),
    dnsFailure: fc.oneof(fc.constant(undefined), fc.constant(true as const)),
  });

  const responseProbe: fc.Arbitrary<Probe> = fc
    .tuple(arbStatus, arbHttpUrl, arbText)
    .map(([status, finalUrl, text]) => ({
      outcome: 'response' as const,
      status,
      finalUrl,
      text,
    }));

  return fc.oneof(timeoutProbe, networkErrorProbe, responseProbe);
}

/** Arbitrary snapshot text (passed as the third arg to classify). */
const arbSnapshotText: fc.Arbitrary<SnapshotResult | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constant({ status: 'none' } as const),
  fc.constant({ status: 'unavailable' } as const),
  fc
    .string({ minLength: 1, maxLength: 500 })
    .map((text): SnapshotResult => ({ status: 'text', text })),
);

// ---------------------------------------------------------------------------
// Property 6
// ---------------------------------------------------------------------------

describe('Property 6: Never cry wolf', () => {
  it('6a: status 401/403/429 never yields dead', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(401, 403, 429),
        arbHttpUrl,
        arbText,
        arbSnapshotText,
        (status, originalUrl, text, snapshotText) => {
          const probe: Probe = { outcome: 'response', status, text };
          const { verdict } = classify(probe, originalUrl, snapshotText);
          return verdict !== 'dead';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('6b: timeout outcome never yields dead', () => {
    fc.assert(
      fc.property(arbHttpUrl, arbSnapshotText, (originalUrl, snapshotText) => {
        const probe: Probe = { outcome: 'timeout' };
        const { verdict } = classify(probe, originalUrl, snapshotText);
        return verdict !== 'dead';
      }),
      { numRuns: 100 },
    );
  });

  it('6c: 5xx status (after retry) yields restless', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 500, max: 599 }),
        arbHttpUrl,
        arbText,
        arbSnapshotText,
        (status, originalUrl, text, snapshotText) => {
          const probe: Probe = { outcome: 'response', status, text };
          const { verdict } = classify(probe, originalUrl, snapshotText);
          return verdict === 'restless';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('6d: same registrable domain never yields possessed', () => {
    // Build a probe whose finalUrl shares the registrable domain with originalUrl.
    fc.assert(
      fc.property(
        fc.tuple(
          fc.stringMatching(/^[a-z]{3,10}$/),
          fc.stringMatching(/^[a-z]{2,6}$/),
        )
          .chain(([name, tld]) => {
            const base = `${name}.${tld}`;
            // originalUrl and finalUrl share the same registrable domain;
            // finalUrl may have a different subdomain or path.
            return fc.tuple(
              fc.constantFrom(`https://${base}/original`, `http://${base}/`),
              fc.constantFrom(
                `https://${base}/other`,
                `https://sub.${base}/page`,
              ),
              arbText,
              arbSnapshotText,
            );
          }),
        ([originalUrl, finalUrl, text, snapshotText]) => {
          // Verify they actually share the same registrable domain.
          const origDomain = registrableDomain(new URL(originalUrl).hostname);
          const finalDomain = registrableDomain(new URL(finalUrl).hostname);
          if (origDomain !== finalDomain) return true; // generator edge case — skip

          const probe: Probe = {
            outcome: 'response',
            status: 200,
            finalUrl,
            text: text ?? '',
          };
          const { verdict } = classify(probe, originalUrl, snapshotText);
          return verdict !== 'possessed';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('6f: network-error without dnsFailure is never dead', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.string()),
        arbHttpUrl,
        arbSnapshotText,
        (text, originalUrl, snapshotText) => {
          const probe: Probe = { outcome: 'network-error', text };
          const { verdict } = classify(probe, originalUrl, snapshotText);
          return verdict !== 'dead';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('6g: cross-domain 2xx with the archive unavailable is never alive or dead', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 200, max: 299 }),
        fc.stringMatching(/^[a-z]{3,10}$/),
        fc.stringMatching(/^[a-z]{3,10}$/),
        arbText,
        (status, a, b, text) => {
          const originalUrl = `https://${a}one.com/page`;
          const finalUrl = `https://${b}two.org/`;
          const probe: Probe = { outcome: 'response', status, finalUrl, text };
          const { verdict } = classify(probe, originalUrl, { status: 'unavailable' });
          return verdict !== 'alive' && verdict !== 'dead';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('6e: every result has exactly one verdict and a non-empty reason', () => {
    const validVerdicts = new Set(['alive', 'dead', 'possessed', 'restless']);
    fc.assert(
      fc.property(arbProbe(), arbHttpUrl, arbSnapshotText, (probe, originalUrl, snapshotText) => {
        const result = classify(probe, originalUrl, snapshotText);
        return (
          validVerdicts.has(result.verdict) &&
          typeof result.reason === 'string' &&
          result.reason.length > 0
        );
      }),
      { numRuns: 100 },
    );
  });

  // Task 18.2: a rename is not a possession.
  const arbName = fc.stringMatching(/^[a-z]{3,10}$/);
  const arbLong = fc.string({ minLength: 0, maxLength: 400 });

  it('6h: the same name under another suffix is never possessed', () => {
    const arbSuffix = fc.constantFrom('com', 'org', 'net', 'io', 'co.uk', 'com.au', 'co.jp');
    fc.assert(
      fc.property(
        arbName,
        arbSuffix,
        arbSuffix,
        arbLong,
        arbSnapshotText,
        (name, s1, s2, text, snapshot) => {
          fc.pre(s1 !== s2);
          const probe: Probe = { outcome: 'response', status: 200, finalUrl: `https://www.${name}.${s2}/`, text };
          const { verdict } = classify(probe, `http://${name}.${s1}/`, snapshot);
          return verdict !== 'possessed';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('6i: a known rename is never possessed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KNOWN_RENAMES.entries()),
        fc.constantFrom('', 'www.', 'mobile.'),
        arbLong,
        arbSnapshotText,
        ([from, to], sub, text, snapshot) => {
          const probe: Probe = { outcome: 'response', status: 200, finalUrl: `https://${to}/x`, text };
          const { verdict } = classify(probe, `https://${sub}${from}/x`, snapshot);
          return verdict !== 'possessed';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('6j: a live text under the threshold is never possessed', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: MIN_LIVE_TEXT_CHARS - 1 }),
        arbName,
        arbName,
        fc.string({ minLength: 1, maxLength: 500 }),
        (text, a, b, snap) => {
          fc.pre(a !== b);
          const probe: Probe = { outcome: 'response', status: 200, finalUrl: `https://${b}two.org/`, text };
          const { verdict } = classify(probe, `https://${a}one.com/`, { status: 'text', text: snap });
          return verdict !== 'possessed';
        },
      ),
      { numRuns: 100 },
    );
  });});
