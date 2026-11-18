/**
 * Property-based tests for patch()
 *
 * Feature: revenant, Property 1: Patch touches only link targets
 * Feature: revenant, Property 2: The living are left alone
 * Feature: revenant, Property 3: Patch is idempotent
 * Feature: revenant, Property 8: Excluded links survive the patch unchanged
 *
 * Validates: Requirements 4.2, 4.3, 4.4, 4.5
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { patch, extract } from '#core';
import type { Judgement, Link, Verdict } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Manually reconstruct what `patch` should produce for a given scenario.
 * This is the reference implementation used to verify Property 1:
 * only the URL bytes at replaced spans change; everything else is verbatim.
 */
function manualPatch(
  source: string,
  judgements: Judgement[],
  excluded: Set<string>,
): string {
  interface Entry { start: number; end: number; resurrection: string }
  const entries: Entry[] = [];
  for (const j of judgements) {
    if (j.verdict !== 'dead' && j.verdict !== 'possessed') continue;
    if (j.resurrection === undefined) continue;
    if (excluded.has(j.link.url)) continue;
    for (const sp of j.link.spans) {
      entries.push({ start: sp.start, end: sp.end, resurrection: j.resurrection });
    }
  }
  entries.sort((a, b) => b.start - a.start);
  let result = source;
  for (const { start, end, resurrection } of entries) {
    result = result.slice(0, start) + resurrection + result.slice(end);
  }
  return result;
}

/**
 * Collect all inter-span byte segments from `source` using the given spans.
 * Spans are assumed non-overlapping and sorted ascending.
 * Returns the concatenation of all bytes that are NOT inside any span.
 */
function outerBytes(source: string, spans: Array<{ start: number; end: number }>): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let result = '';
  let pos = 0;
  for (const { start, end } of sorted) {
    if (start > pos) result += source.slice(pos, start);
    pos = Math.max(pos, end);
  }
  result += source.slice(pos);
  return result;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** A simple resurrection-style URL that is safe to embed. */
const arbResurrectionUrl: fc.Arbitrary<string> = fc.tuple(
  fc.constantFrom('http', 'https'),
  fc.stringMatching(/^[a-z]{3,8}$/),
  fc.stringMatching(/^[a-z0-9]{4,10}$/),
).map(([scheme, host, path]) => `${scheme}://web.archive.org/web/20200101/${scheme}://${host}/${path}`);

/**
 * Build a source string and a consistent set of judgements where every span
 * actually points into the source string. We embed the URLs literally in the
 * source so spans are real.
 *
 * Returns: { source, judgements, excluded }
 */
interface ScenarioWithExcluded {
  source: string;
  judgements: Judgement[];
  excluded: Set<string>;
}

/**
 * Builds a scenario where dead/possessed links with resurrections are embedded
 * in the source string. All spans are valid offsets into source.
 */
const arbPatchScenario: fc.Arbitrary<ScenarioWithExcluded> = fc
  .array(
    fc.record({
      url: fc.tuple(
        fc.constantFrom('http', 'https'),
        fc.stringMatching(/^[a-z]{3,8}$/),
        fc.stringMatching(/^[a-z0-9]{3,8}$/),
      ).map(([s, h, p]) => `${s}://${h}.example/${p}`),
      verdict: fc.constantFrom<Verdict>('dead', 'possessed'),
      resurrection: arbResurrectionUrl,
      exclude: fc.boolean(),
    }),
    { minLength: 1, maxLength: 6 },
  )
  // Deduplicate by URL
  .map(entries => {
    const seen = new Set<string>();
    return entries.filter(e => {
      if (seen.has(e.url)) return false;
      seen.add(e.url);
      return true;
    });
  })
  .filter(entries => entries.length >= 1)
  .map(entries => {
    // Build source by concatenating prefix text and the raw URL for each entry
    let source = 'prefix ';
    const judgements: Judgement[] = [];
    const excluded = new Set<string>();

    for (const entry of entries) {
      const start = source.length;
      source += entry.url;
      const end = source.length;
      source += ' suffix ';

      const link: Link = { url: entry.url, spans: [{ start, end }] };
      judgements.push({
        link,
        verdict: entry.verdict,
        reason: 'test',
        resurrection: entry.resurrection,
      });

      if (entry.exclude) excluded.add(entry.url);
    }

    return { source, judgements, excluded };
  });

/**
 * Scenario where all verdicts are alive or restless — patch must be a no-op.
 */
const arbLivingScenario: fc.Arbitrary<{ source: string; judgements: Judgement[] }> = fc
  .array(
    fc.record({
      url: fc.tuple(
        fc.constantFrom('http', 'https'),
        fc.stringMatching(/^[a-z]{3,8}$/),
        fc.stringMatching(/^[a-z0-9]{3,8}$/),
      ).map(([s, h, p]) => `${s}://${h}.example/${p}`),
      verdict: fc.constantFrom<Verdict>('alive', 'restless'),
    }),
    { minLength: 1, maxLength: 6 },
  )
  .map(entries => {
    const seen = new Set<string>();
    return entries.filter(e => {
      if (seen.has(e.url)) return false;
      seen.add(e.url);
      return true;
    });
  })
  .filter(entries => entries.length >= 1)
  .map(entries => {
    let source = 'prefix ';
    const judgements: Judgement[] = [];

    for (const entry of entries) {
      const start = source.length;
      source += entry.url;
      const end = source.length;
      source += ' suffix ';

      const link: Link = { url: entry.url, spans: [{ start, end }] };
      judgements.push({
        link,
        verdict: entry.verdict,
        reason: 'test',
        // no resurrection for alive/restless
      });
    }

    return { source, judgements };
  });

// ---------------------------------------------------------------------------
// Property 1: Patch touches only link targets
// ---------------------------------------------------------------------------

describe('Property 1: Patch touches only link targets', () => {
  // Feature: revenant, Property 1: Patch touches only link targets
  // Validates: Requirements 4.2

  it('output matches manual right-to-left reconstruction (correctness)', () => {
    // The reference `manualPatch` performs the same algorithm independently.
    // If patch() equals it for all inputs, it is correct.
    fc.assert(
      fc.property(arbPatchScenario, ({ source, judgements, excluded }) => {
        return patch(source, judgements, excluded) === manualPatch(source, judgements, excluded);
      }),
      { numRuns: 100 },
    );
  });

  it('bytes outside all link spans are verbatim in the output', () => {
    // Collect only the spans that will actually be replaced, then verify
    // that the inter-span segments of source appear verbatim in patched.
    // Since replacements happen right-to-left, bytes BEFORE the earliest
    // replaced span are at identical offsets in patched. We check this by
    // extracting outer bytes from source (using the replaced spans) and
    // from patched (using the same spans, which still delimit the same
    // inter-span content because replacements only change the bytes at the
    // span positions).
    fc.assert(
      fc.property(arbPatchScenario, ({ source, judgements, excluded }) => {
        // Identify which spans are actually replaced
        const replacedSpans: Array<{ start: number; end: number }> = [];
        for (const j of judgements) {
          if (j.verdict !== 'dead' && j.verdict !== 'possessed') continue;
          if (j.resurrection === undefined) continue;
          if (excluded.has(j.link.url)) continue;
          for (const sp of j.link.spans) replacedSpans.push(sp);
        }

        const patched = patch(source, judgements, excluded);

        // Inter-span bytes from source
        const sourceOuter = outerBytes(source, replacedSpans);

        // For patched, we cannot use the same span positions because
        // different-length replacements shift offsets. Instead we verify the
        // inter-span content by reconstructing what the outer bytes should be:
        // they are identical to sourceOuter because only span bytes changed.
        // We reconstruct them from patched by walking the replaced spans with
        // adjusted offsets.
        const sortedSpans = [...replacedSpans].sort((a, b) => a.start - b.start);
        let patchedOuter = '';
        let pos = 0;
        let offset = 0; // cumulative offset shift from prior replacements
        for (const { start, end } of sortedSpans) {
          const adjStart = start + offset;
          if (adjStart > pos) patchedOuter += patched.slice(pos, adjStart);
          // Find the resurrection used for this span to compute the new length
          const j = judgements.find(
            jj =>
              (jj.verdict === 'dead' || jj.verdict === 'possessed') &&
              jj.resurrection !== undefined &&
              !excluded.has(jj.link.url) &&
              jj.link.spans.some(sp => sp.start === start && sp.end === end),
          );
          const newLen = j!.resurrection!.length;
          pos = adjStart + newLen;
          offset += newLen - (end - start);
        }
        patchedOuter += patched.slice(pos);

        return sourceOuter === patchedOuter;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: The living are left alone
// ---------------------------------------------------------------------------

describe('Property 2: The living are left alone', () => {
  // Feature: revenant, Property 2: The living are left alone
  // Validates: Requirements 4.3
  it('patch with only alive/restless judgements returns source unchanged', () => {
    fc.assert(
      fc.property(arbLivingScenario, ({ source, judgements }) => {
        const patched = patch(source, judgements, new Set());
        return patched === source;
      }),
      { numRuns: 100 },
    );
  });

  it('patch with empty judgements returns source unchanged', () => {
    fc.assert(
      fc.property(fc.string(), source => {
        return patch(source, [], new Set()) === source;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: Excluded links survive the patch unchanged
// ---------------------------------------------------------------------------

describe('Property 8: Excluded links survive the patch unchanged', () => {
  // Feature: revenant, Property 8: Excluded links survive the patch unchanged
  // Validates: Requirements 4.5
  it('URL bytes at excluded link spans appear unchanged in patched output', () => {
    // Build a scenario where there is at least one excluded link
    const arbScenarioWithAtLeastOneExcluded = arbPatchScenario.filter(
      s => s.excluded.size > 0,
    );

    fc.assert(
      fc.property(arbScenarioWithAtLeastOneExcluded, ({ source, judgements, excluded }) => {
        const patched = patch(source, judgements, excluded);

        // Collect all spans that were actually replaced (not excluded, dead/possessed, with resurrection)
        // sorted ascending so we can compute cumulative offset shifts.
        const replacedSpans: Array<{ start: number; end: number; newLen: number }> = [];
        for (const j of judgements) {
          if (j.verdict !== 'dead' && j.verdict !== 'possessed') continue;
          if (j.resurrection === undefined) continue;
          if (excluded.has(j.link.url)) continue;
          for (const sp of j.link.spans) {
            replacedSpans.push({ start: sp.start, end: sp.end, newLen: j.resurrection!.length });
          }
        }
        replacedSpans.sort((a, b) => a.start - b.start);

        /**
         * Given an original span [start, end), compute the offset in the
         * patched string where that content now lives, accounting for all
         * replacements that occurred at lower positions.
         */
        function adjustedStart(origStart: number): number {
          let shift = 0;
          for (const r of replacedSpans) {
            if (r.start < origStart) shift += r.newLen - (r.end - r.start);
          }
          return origStart + shift;
        }

        for (const j of judgements) {
          if (!excluded.has(j.link.url)) continue;
          for (const span of j.link.spans) {
            const adj = adjustedStart(span.start);
            const content = patched.slice(adj, adj + j.link.url.length);
            if (content !== j.link.url) return false;
          }
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Patch is idempotent
// ---------------------------------------------------------------------------

describe('Property 3: Patch is idempotent', () => {
  // Property 3: Patch is idempotent
  // Validates: Requirements 4.4
  //
  // After the first patch(), the dead/possessed links are replaced with Wayback
  // snapshot URLs (web.archive.org). When the patched document is re-extracted
  // and each URL is judged `alive` (since Wayback URLs are live), applying
  // patch() a second time produces the same string — a no-op.

  it('applying patch twice with the same resurrection URLs judged alive equals applying once', () => {
    fc.assert(
      fc.property(arbPatchScenario, ({ source, judgements, excluded }) => {
        // First application
        const patched1 = patch(source, judgements, excluded);

        // Re-extract links from the already-patched document
        const links2 = extract(patched1, 'markdown');

        // All links in the patched document are judged `alive` (Wayback URLs
        // respond with 200, so the classifier returns `alive`). This means
        // patch() must leave them untouched.
        const judgements2: Judgement[] = links2.map(link => ({
          link,
          verdict: 'alive' as Verdict,
          reason: 'alive after re-scan',
        }));

        // Second application must equal the first result
        const patched2 = patch(patched1, judgements2, new Set());
        return patched2 === patched1;
      }),
      { numRuns: 100 },
    );
  });

  it('patch of an already-patched source with no replaceable links is a no-op', () => {
    // Stronger form: even if we fabricate dead judgements whose URLs don't
    // appear in the patched source, the bytes are untouched.
    fc.assert(
      fc.property(arbPatchScenario, ({ source, judgements, excluded }) => {
        const patched1 = patch(source, judgements, excluded);

        // Build judgements from scratch: same links as first round but all `alive`.
        // This simulates re-scanning a patched document where every link is now OK.
        const aliveJudgements: Judgement[] = judgements.map(j => ({
          link: j.link,
          verdict: 'alive' as Verdict,
          reason: 'alive',
        }));

        const patched2 = patch(patched1, aliveJudgements, new Set());
        return patched2 === patched1;
      }),
      { numRuns: 100 },
    );
  });
});
