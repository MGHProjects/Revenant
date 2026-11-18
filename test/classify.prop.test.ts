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
 *   6e. Every result has exactly one verdict and a non-empty reason.
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { classify } from '../src/core/classify.ts';
import { registrableDomain } from '../src/core/domain.ts';
import type { Probe } from '../src/core/types.ts';

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
const arbSnapshotText = fc.oneof(
  fc.constant(undefined),
  fc.string({ minLength: 1, maxLength: 500 }),
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
});
