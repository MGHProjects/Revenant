/**
 * Property-based tests for scan()
 *
 * // Feature: revenant, Property 9: Deduplication invariant
 * // Feature: revenant, Property 10: Concurrency cap invariant
 */

// Feature: revenant, Property 9: Deduplication invariant
// Feature: revenant, Property 10: Concurrency cap invariant

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { scan } from '../src/net/scan.js';
import type { Fetcher, Probe, Wayback } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Instrumented fake Fetcher
// ---------------------------------------------------------------------------

interface FetcherStats {
  peak: number;
  current: number;
}

/**
 * Creates a fake Fetcher that:
 * - Tracks the number of calls currently in flight (concurrent count)
 * - Records the peak concurrent count across all calls
 * - Returns a valid alive Probe after a small artificial delay (10 ms)
 */
function makeFakeFetcher(stats: FetcherStats): Fetcher {
  return async (_url: string): Promise<Probe> => {
    // Increment in-flight counter before any await.
    stats.current += 1;
    if (stats.current > stats.peak) {
      stats.peak = stats.current;
    }

    // Small delay so other concurrent calls are truly in-flight simultaneously.
    await new Promise<void>(resolve => setTimeout(resolve, 10));

    // Decrement after the artificial delay (simulates work completing).
    stats.current -= 1;

    return {
      outcome: 'response',
      status: 200,
      finalUrl: _url,
      text: 'some page content',
    };
  };
}

// ---------------------------------------------------------------------------
// Fake Wayback — always returns 'unavailable'
// ---------------------------------------------------------------------------

const fakeWayback: Wayback = {
  async getEpitaph(_url: string) {
    return 'unavailable';
  },
  async getResurrection(_url: string) {
    return undefined;
  },
  async getSnapshotText(_url: string) {
    return { status: 'none' };
  },
};

// ---------------------------------------------------------------------------
// Arbitrary: a valid http/https URL safe for embedding in Markdown
// ---------------------------------------------------------------------------

/**
 * Produces URL strings that:
 * - Use http or https
 * - Have a simple public hostname (no IP literals, no blocked suffixes)
 * - Have a path that avoids Markdown special characters
 * - Each URL is unique by using an index-based path segment
 */
function makeUniqueUrls(count: number): string[] {
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    // Use distinct paths to ensure uniqueness
    urls.push(`https://example${i}.com/page${i}`);
  }
  return urls;
}

/**
 * Builds a Markdown source string containing each URL as a bare link
 * (token starting with https://) so extract() picks them all up.
 */
function buildMarkdownSource(urls: string[]): string {
  return urls.map(url => `See ${url} for details.`).join('\n');
}

// ---------------------------------------------------------------------------
// Property 10: Concurrency cap invariant
// ---------------------------------------------------------------------------

describe('Property 10: Concurrency cap invariant', () => {
  it(
    'in-flight fetcher calls never exceed 6 for any scan over more than 6 URLs',
    async () => {
      // Feature: revenant, Property 10: Concurrency cap invariant
      // Validates: Requirements 5.4

      await fc.assert(
        fc.asyncProperty(
          // Generate a URL count in [7, 20]
          fc.integer({ min: 7, max: 20 }),
          async (urlCount: number) => {
            const urls = makeUniqueUrls(urlCount);
            const source = buildMarkdownSource(urls);

            const stats: FetcherStats = { peak: 0, current: 0 };
            const fetcher = makeFakeFetcher(stats);

            // Collect all events from the scan generator
            const events = [];
            for await (const event of scan(source, 'markdown', fetcher, fakeWayback, new Date())) {
              events.push(event);
            }

            // The peak concurrent fetcher calls must never exceed the pool size of 6
            if (stats.peak > 6) {
              return false;
            }

            return true;
          },
        ),
        { numRuns: 100 },
      );
    },
    // Generous timeout: 100 iterations × 20 URLs × 10 ms delay ÷ 6 concurrency ≈ ~3.4 s
    // Add buffer for overhead
    { timeout: 60_000 },
  );
});

// ---------------------------------------------------------------------------
// Property 9: Deduplication invariant
// ---------------------------------------------------------------------------

describe('Property 9: Deduplication invariant', () => {
  it(
    'fetcher is called exactly once per unique URL and judgement spans match occurrence count',
    async () => {
      // Feature: revenant, Property 9: Deduplication invariant
      // Validates: Requirements 1.6

      await fc.assert(
        fc.asyncProperty(
          // Choose a path suffix to make each generated URL unique across runs,
          // then how many times that URL appears in the source (2–4).
          fc.integer({ min: 0, max: 9999 }),
          fc.integer({ min: 2, max: 4 }),
          async (seed: number, repeatCount: number) => {
            // The URL must pass guard(): http/https, public hostname, no IP literals.
            const duplicateUrl = `https://example-dup${seed}.com/page`;

            // Build Markdown with `repeatCount` occurrences of the URL as bare URLs,
            // each in a different surrounding sentence so they are distinct in the text.
            const lines: string[] = [];
            for (let i = 0; i < repeatCount; i++) {
              lines.push(`Line ${i}: visit ${duplicateUrl} for more info.`);
            }
            const source = lines.join('\n');

            // Instrumented fetcher: counts calls per URL.
            const callCounts = new Map<string, number>();
            const countingFetcher: Fetcher = async (url: string): Promise<Probe> => {
              callCounts.set(url, (callCounts.get(url) ?? 0) + 1);
              return {
                outcome: 'response',
                status: 200,
                finalUrl: url,
                text: 'page content',
              };
            };

            // Fake Wayback — not needed for this property.
            const noopWayback: Wayback = {
              async getEpitaph() { return 'unavailable'; },
              async getResurrection() { return undefined; },
              async getSnapshotText() { return { status: 'none' }; },
            };

            // Collect judgements from scan.
            const judgements = [];
            for await (const event of scan(source, 'markdown', countingFetcher, noopWayback, new Date())) {
              if (event.type === 'judgement') {
                judgements.push(event.judgement);
              }
            }

            // The duplicate URL must appear in exactly one judgement.
            const matchingJudgements = judgements.filter(j => j.link.url === duplicateUrl);
            if (matchingJudgements.length !== 1) return false;

            const judgement = matchingJudgements[0]!;

            // The fetcher must have been called exactly once for this URL.
            const fetchCount = callCounts.get(duplicateUrl) ?? 0;
            if (fetchCount !== 1) return false;

            // The judgement's span count must equal the number of occurrences.
            if (judgement.link.spans.length !== repeatCount) return false;

            return true;
          },
        ),
        { numRuns: 100 },
      );
    },
    { timeout: 30_000 },
  );
});
