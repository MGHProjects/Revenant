/**
 * Property-based tests for extract()
 *
 * Feature: revenant, Property 4: Extraction round-trips
 * Feature: revenant, Property 9: Deduplication invariant
 *
 * Validates: Requirements 1.1, 1.2, 1.5, 1.6
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { extract } from '../src/core/extract.js';
import type { Link } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Arbitrary: a valid http/https URL with no special markdown characters
// ---------------------------------------------------------------------------

/**
 * Produces URL strings that are safe to embed in Markdown without ambiguity:
 * - Only http or https
 * - Hostname is a simple domain (no credentials, no IP literals)
 * - Path chars avoid `(`, `)`, `[`, `]`, `<`, `>`, `"`, `'`, whitespace, and
 *   backticks so the URL is extracted verbatim in every Markdown form.
 */
const arbSafeUrl: fc.Arbitrary<string> = fc.tuple(
  fc.constantFrom('http', 'https'),
  // hostname: 1–3 labels of 2–8 lowercase letters
  fc.array(
    fc.stringMatching(/^[a-z]{2,8}$/),
    { minLength: 1, maxLength: 3 },
  ).map(labels => labels.join('.')),
  // path: 0–3 segments of 2–10 lowercase letters/digits
  fc.array(
    fc.stringMatching(/^[a-z0-9]{2,10}$/),
    { minLength: 0, maxLength: 3 },
  ),
).map(([scheme, host, segments]) => {
  const path = segments.length > 0 ? '/' + segments.join('/') : '';
  return `${scheme}://${host}${path}`;
});

/** Produces a deduplicated array of 1–8 safe URLs. */
const arbUrlList: fc.Arbitrary<string[]> = fc
  .array(arbSafeUrl, { minLength: 1, maxLength: 8 })
  .map(urls => [...new Set(urls)])
  .filter(urls => urls.length >= 1);

// ---------------------------------------------------------------------------
// Markdown source generator
// ---------------------------------------------------------------------------

/**
 * The four link forms a URL can take in Markdown, plus fenced.
 * We call these "slots". Each URL gets one slot per occurrence.
 */
type MarkdownForm = 'inline' | 'reference' | 'autolink' | 'bare' | 'fenced';

/**
 * Result of arbMarkdownSource.
 * - `source`: the full Markdown string
 * - `unfenced`: URLs that appear at least once outside a fenced block
 * - `urlForms`: for each url, the form used for each occurrence
 */
interface MarkdownResult {
  source: string;
  unfenced: Set<string>;
  // map url → list of forms used (one entry per occurrence)
  occurrences: Map<string, MarkdownForm[]>;
}

/**
 * Produces a Markdown string containing each URL in a randomly chosen form.
 * Some URLs may appear multiple times (Property 9) and some occurrences may
 * be inside fenced code blocks (Property 4 exclusion).
 *
 * Reference definitions are collected and appended at the bottom of the
 * source so they are always found by the extractor.
 */
function arbMarkdownSource(urls: string[]): fc.Arbitrary<MarkdownResult> {
  if (urls.length === 0) {
    return fc.constant({
      source: '',
      unfenced: new Set<string>(),
      occurrences: new Map<string, MarkdownForm[]>(),
    });
  }

  // For each URL, pick 1–3 occurrences, each with its own form.
  const perUrl: Array<fc.Arbitrary<{ url: string; forms: MarkdownForm[] }>> = urls.map(url =>
    fc.array(
      fc.constantFrom<MarkdownForm>('inline', 'reference', 'autolink', 'bare', 'fenced'),
      { minLength: 1, maxLength: 3 },
    ).map(forms => ({ url, forms })),
  );

  return fc.tuple(...(perUrl as [fc.Arbitrary<{ url: string; forms: MarkdownForm[] }>, ...Array<fc.Arbitrary<{ url: string; forms: MarkdownForm[] }>>]))
    .map(entries => buildMarkdownSource(entries, urls));
}

function buildMarkdownSource(
  entries: Array<{ url: string; forms: MarkdownForm[] }>,
  _urls: string[],
): MarkdownResult {
  const lines: string[] = [];
  const refDefs: string[] = []; // gathered for bottom-of-document append
  const refIdsSeen = new Set<string>(); // avoid duplicate definitions
  const occurrences = new Map<string, MarkdownForm[]>();
  const unfenced = new Set<string>();

  for (const { url, forms } of entries) {
    occurrences.set(url, forms);
    for (const form of forms) {
      if (form !== 'fenced') unfenced.add(url);
    }
  }

  // Build the body — one line per occurrence
  let refCounter = 0;
  for (const { url, forms } of entries) {
    for (const form of forms) {
      switch (form) {
        case 'inline': {
          lines.push(`[link text](${url})`);
          break;
        }
        case 'autolink': {
          lines.push(`<${url}>`);
          break;
        }
        case 'bare': {
          lines.push(`Visit ${url} for more.`);
          break;
        }
        case 'reference': {
          // Each URL gets a unique reference id; if the same URL appears
          // multiple times as 'reference' we reuse the same id but only emit
          // the definition once.
          const id = `ref${refCounter++}`;
          lines.push(`[link text][${id}]`);
          if (!refIdsSeen.has(id)) {
            refIdsSeen.add(id);
            refDefs.push(`[${id}]: ${url}`);
          }
          break;
        }
        case 'fenced': {
          lines.push('```');
          lines.push(`Check out ${url} and [click](${url})`);
          lines.push('```');
          break;
        }
      }
    }
    lines.push(''); // blank line between entries
  }

  // Append all reference definitions at the end
  if (refDefs.length > 0) {
    lines.push('');
    lines.push(...refDefs);
  }

  const source = lines.join('\n');
  return { source, unfenced, occurrences };
}

// ---------------------------------------------------------------------------
// HTML source generator
// ---------------------------------------------------------------------------

interface HtmlResult {
  source: string;
  /** All URLs that appear at least once as an <a href> */
  urls: Set<string>;
  /** url → number of <a href> occurrences */
  counts: Map<string, number>;
}

/**
 * Builds an HTML string with each URL as one or more `<a href="url">text</a>`
 * elements. Some URLs repeat (for Property 9).
 */
function arbHtmlSource(urls: string[]): fc.Arbitrary<HtmlResult> {
  if (urls.length === 0) {
    return fc.constant({ source: '', urls: new Set<string>(), counts: new Map<string, number>() });
  }

  const perUrl: Array<fc.Arbitrary<{ url: string; count: number }>> = urls.map(url =>
    fc.integer({ min: 1, max: 3 }).map(count => ({ url, count })),
  );

  return fc.tuple(...(perUrl as [fc.Arbitrary<{ url: string; count: number }>, ...Array<fc.Arbitrary<{ url: string; count: number }>>]))
    .map(entries => {
      const parts: string[] = ['<html><body>'];
      const urlSet = new Set<string>();
      const counts = new Map<string, number>();
      for (const { url, count } of entries) {
        urlSet.add(url);
        counts.set(url, count);
        for (let i = 0; i < count; i++) {
          parts.push(`<a href="${url}">link</a>`);
        }
      }
      parts.push('</body></html>');
      return { source: parts.join('\n'), urls: urlSet, counts };
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Index a Link[] by URL for fast lookup. */
function indexByUrl(links: Link[]): Map<string, Link> {
  const m = new Map<string, Link>();
  for (const link of links) m.set(link.url, link);
  return m;
}

// ---------------------------------------------------------------------------
// Property 4: Extraction round-trips (Markdown)
// ---------------------------------------------------------------------------

describe('Property 4: Extraction round-trips', () => {
  it('Markdown: extract returns exactly the unfenced URLs, with correct spans', () => {
    // Feature: revenant, Property 4: Extraction round-trips
    fc.assert(
      fc.property(arbUrlList, urls => {
        const { source, unfenced } = fc.sample(arbMarkdownSource(urls), { numRuns: 1 })[0]!;

        const links = extract(source, 'markdown');
        const extracted = new Set(links.map(l => l.url));

        // Every unfenced URL must appear in results
        for (const url of unfenced) {
          if (!extracted.has(url)) return false;
        }

        // No URL outside unfenced should appear (unless it also had an unfenced occurrence)
        for (const url of extracted) {
          if (!unfenced.has(url)) return false;
        }

        // Every span must round-trip: source.slice(start, end) === url
        for (const link of links) {
          for (const span of link.spans) {
            if (source.slice(span.start, span.end) !== link.url) return false;
          }
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('Markdown: each span byte-range equals the URL string verbatim', () => {
    // Feature: revenant, Property 4: Extraction round-trips
    fc.assert(
      fc.property(arbUrlList, urls => {
        const { source } = fc.sample(arbMarkdownSource(urls), { numRuns: 1 })[0]!;
        const links = extract(source, 'markdown');
        return links.every(link =>
          link.spans.every(span => source.slice(span.start, span.end) === link.url),
        );
      }),
      { numRuns: 100 },
    );
  });

  it('HTML: extract returns exactly the linked URLs, with correct spans', () => {
    // Feature: revenant, Property 4: Extraction round-trips
    fc.assert(
      fc.property(arbUrlList, urls => {
        const { source, urls: expectedUrls } = fc.sample(arbHtmlSource(urls), { numRuns: 1 })[0]!;

        const links = extract(source, 'html');
        const extracted = new Set(links.map(l => l.url));

        // Exact match between expected and extracted URL sets
        if (extracted.size !== expectedUrls.size) return false;
        for (const url of expectedUrls) {
          if (!extracted.has(url)) return false;
        }

        // Every span must round-trip
        for (const link of links) {
          for (const span of link.spans) {
            if (source.slice(span.start, span.end) !== link.url) return false;
          }
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Deduplication invariant
// ---------------------------------------------------------------------------

describe('Property 9: Deduplication invariant', () => {
  it('Markdown: same URL at multiple locations → one Link, span count = occurrence count', () => {
    // Feature: revenant, Property 9: Deduplication invariant
    //
    // We use a single URL repeated in multiple non-fenced forms so we can
    // count exactly how many occurrences the extractor should find.
    fc.assert(
      fc.property(
        arbSafeUrl,
        // 2–4 non-fenced forms for the same URL
        fc.array(
          fc.constantFrom<MarkdownForm>('inline', 'autolink', 'bare'),
          { minLength: 2, maxLength: 4 },
        ),
        (url, forms) => {
          // Build source with the same URL in each chosen form
          const result = buildMarkdownSource([{ url, forms }], [url]);
          const { source, unfenced } = result;

          // If the URL ended up fenced somehow, skip (shouldn't happen with
          // the forms we chose, but be defensive)
          if (!unfenced.has(url)) return true;

          const links = extract(source, 'markdown');
          const index = indexByUrl(links);

          const link = index.get(url);
          if (!link) return false;

          // Exactly one Link for this URL
          if (links.filter(l => l.url === url).length !== 1) return false;

          // Span count equals occurrence count
          if (link.spans.length !== forms.length) return false;

          // All spans round-trip
          return link.spans.every(span => source.slice(span.start, span.end) === url);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('HTML: same URL in multiple <a href> elements → one Link, span count = element count', () => {
    // Feature: revenant, Property 9: Deduplication invariant
    fc.assert(
      fc.property(
        arbSafeUrl,
        fc.integer({ min: 2, max: 5 }),
        (url, count) => {
          const parts: string[] = ['<html><body>'];
          for (let i = 0; i < count; i++) {
            parts.push(`<a href="${url}">link ${i}</a>`);
          }
          parts.push('</body></html>');
          const source = parts.join('\n');

          const links = extract(source, 'html');

          // Exactly one Link for this URL
          const matching = links.filter(l => l.url === url);
          if (matching.length !== 1) return false;

          const link = matching[0]!;

          // Span count equals element count
          if (link.spans.length !== count) return false;

          // All spans round-trip
          return link.spans.every(span => source.slice(span.start, span.end) === url);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Markdown: extract never returns duplicate Link objects for the same URL', () => {
    // Feature: revenant, Property 9: Deduplication invariant
    fc.assert(
      fc.property(arbUrlList, urls => {
        const { source } = fc.sample(arbMarkdownSource(urls), { numRuns: 1 })[0]!;
        const links = extract(source, 'markdown');
        const seen = new Set<string>();
        for (const link of links) {
          if (seen.has(link.url)) return false;
          seen.add(link.url);
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('HTML: extract never returns duplicate Link objects for the same URL', () => {
    // Feature: revenant, Property 9: Deduplication invariant
    fc.assert(
      fc.property(arbUrlList, urls => {
        const { source } = fc.sample(arbHtmlSource(urls), { numRuns: 1 })[0]!;
        const links = extract(source, 'html');
        const seen = new Set<string>();
        for (const link of links) {
          if (seen.has(link.url)) return false;
          seen.add(link.url);
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
