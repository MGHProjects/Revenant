/**
 * Integration test for scan() using fake Fetcher and fake Wayback.
 *
 * Covers:
 *   - DNS failure          → dead
 *   - 404                  → dead
 *   - 5xx successful retry → alive
 *   - 5xx failed retry     → restless
 *   - 403                  → restless
 *   - timeout              → restless
 *   - 2xx same-domain redirect → alive
 *   - 2xx cross-domain + low-similarity snapshot → possessed
 *   - 2xx plain alive (×2 for breadth)
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 3.1, 3.2
 */

import { describe, it, expect } from 'vitest';
import { scan } from '../src/net/scan.ts';
import { archiveNote } from '../src/core/archive-note.ts';
import type { Fetcher, Probe, SnapshotResult, Wayback, ArchiveAnswer, Epitaph, Judgement } from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// Test URLs — one per scenario
// ---------------------------------------------------------------------------

const URL_DNS_FAIL = 'http://dns-fail.example.com/';
const URL_NOT_FOUND = 'http://not-found.example.com/';
const URL_RETRY_OK = 'http://retry-ok.example.com/';
const URL_RETRY_FAIL = 'http://retry-fail.example.com/';
const URL_FORBIDDEN = 'http://forbidden.example.com/';
const URL_TIMEOUT = 'http://timeout.example.com/';
const URL_REDIRECT_SAME = 'http://redirect-same.example.com/';
const URL_POSSESSED = 'http://possessed.example.com/';
const URL_ALIVE_A = 'http://alive-a.example.com/';
const URL_ALIVE_B = 'http://alive-b.example.com/';

// ---------------------------------------------------------------------------
// 10-link Markdown document — one URL per scenario
// ---------------------------------------------------------------------------

const DOCUMENT = [
  `Check these links:`,
  ``,
  `- [DNS fail](${URL_DNS_FAIL})`,
  `- [Not found](${URL_NOT_FOUND})`,
  `- [Retry OK](${URL_RETRY_OK})`,
  `- [Retry fail](${URL_RETRY_FAIL})`,
  `- [Forbidden](${URL_FORBIDDEN})`,
  `- [Timeout](${URL_TIMEOUT})`,
  `- [Redirect same domain](${URL_REDIRECT_SAME})`,
  `- [Possessed](${URL_POSSESSED})`,
  `- [Alive A](${URL_ALIVE_A})`,
  `- [Alive B](${URL_ALIVE_B})`,
].join('\n');

// ---------------------------------------------------------------------------
// Fake Wayback
// ---------------------------------------------------------------------------

const EPITAPH: Epitaph = { first: '2015-01-01', last: '2020-01-01' };
const RESURRECTION_URL = 'https://web.archive.org/web/20200101000000/http://possessed.example.com/';

// Text with zero word overlap with the live page text below.
const SNAPSHOT_TEXT_POSSESSED =
  'ancient archived content from the original site completely different words';

// Live page body for the possessed URL — no shared 3-word shingles with the snapshot.
const LIVE_TEXT_POSSESSED =
  'fresh modern spam advertisement buy now limited offer discount sale promotion';

const fakeWayback: Wayback = {
  async getArchive(url: string): Promise<ArchiveAnswer> {
    if (url === URL_POSSESSED || url === URL_DNS_FAIL || url === URL_NOT_FOUND) {
      return { epitaph: EPITAPH, resurrection: RESURRECTION_URL };
    }
    return { epitaph: 'none' };
  },

  async getSnapshotText(url: string): Promise<SnapshotResult> {
    if (url === URL_POSSESSED) {
      return { status: 'text', text: SNAPSHOT_TEXT_POSSESSED };
    }
    return { status: 'none' };
  },
};

// ---------------------------------------------------------------------------
// Fake Fetcher
// ---------------------------------------------------------------------------

// Track call counts for the 5xx URLs so we can simulate retry behaviour.
const callCounts = new Map<string, number>();

const fakeFetcher: Fetcher = async (url: string): Promise<Probe> => {
  const count = (callCounts.get(url) ?? 0) + 1;
  callCounts.set(url, count);

  switch (url) {
    case URL_DNS_FAIL:
      return { outcome: 'network-error', text: 'ENOTFOUND dns-fail.example.com', dnsFailure: true };

    case URL_NOT_FOUND:
      return { outcome: 'response', status: 404, finalUrl: url, text: '' };

    case URL_RETRY_OK:
      // First call: 503. Second call (retry by scan): 200.
      if (count === 1) {
        return { outcome: 'response', status: 503, finalUrl: url, text: '' };
      }
      return { outcome: 'response', status: 200, finalUrl: url, text: 'page content' };

    case URL_RETRY_FAIL:
      // Both calls: 503.
      return { outcome: 'response', status: 503, finalUrl: url, text: '' };

    case URL_FORBIDDEN:
      return { outcome: 'response', status: 403, finalUrl: url, text: '' };

    case URL_TIMEOUT:
      return { outcome: 'timeout' };

    case URL_REDIRECT_SAME:
      // 200 response with finalUrl on the same registrable domain.
      return {
        outcome: 'response',
        status: 200,
        finalUrl: 'http://www.redirect-same.example.com/page',
        text: 'same domain content',
      };

    case URL_POSSESSED:
      // 200 response with finalUrl on a different registrable domain.
      return {
        outcome: 'response',
        status: 200,
        finalUrl: 'http://hijacked-domain.net/ads',
        text: LIVE_TEXT_POSSESSED,
      };

    case URL_ALIVE_A:
      return { outcome: 'response', status: 200, finalUrl: url, text: 'alive content A' };

    case URL_ALIVE_B:
      return { outcome: 'response', status: 200, finalUrl: url, text: 'alive content B' };

    default:
      return { outcome: 'network-error', text: `unexpected url in test: ${url}` };
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all judgements from the scan generator into a Map keyed by URL. */
async function runScan(): Promise<Map<string, Judgement>> {
  // Reset call counts before each run.
  callCounts.clear();

  const results = new Map<string, Judgement>();
  for await (const event of scan(DOCUMENT, 'markdown', fakeFetcher, fakeWayback)) {
    if (event.type === 'judgement') {
      results.set(event.judgement.link.url, event.judgement);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scan() integration — fake Fetcher and Wayback', () => {
  // We run scan once and share the result across assertions.
  let judgements: Map<string, Judgement>;

  it('produces judgements for all 10 URLs', async () => {
    judgements = await runScan();
    expect(judgements.size).toBe(10);
  });

  // ---- Requirement 2.1: DNS failure → dead ----
  it('DNS failure → dead (Requirement 2.1)', () => {
    const j = judgements.get(URL_DNS_FAIL);
    expect(j).toBeDefined();
    expect(j!.verdict).toBe('dead');
    expect(j!.reason).toBe('The domain no longer resolves.');
  });

  // ---- Requirement 2.1: 404 → dead ----
  it('404 → dead (Requirement 2.1)', () => {
    const j = judgements.get(URL_NOT_FOUND);
    expect(j).toBeDefined();
    expect(j!.verdict).toBe('dead');
    expect(j!.reason).toBe('Answers 404.');
  });

  // ---- Requirement 2.2: 5xx + successful retry → alive ----
  it('5xx with successful retry → alive (Requirement 2.2)', () => {
    const j = judgements.get(URL_RETRY_OK);
    expect(j).toBeDefined();
    expect(j!.verdict).toBe('alive');
  });

  // ---- Requirement 2.2: 5xx + failed retry → restless ----
  it('5xx with failed retry → restless (Requirement 2.2)', () => {
    const j = judgements.get(URL_RETRY_FAIL);
    expect(j).toBeDefined();
    expect(j!.verdict).toBe('restless');
    expect(j!.reason).toBe('Answers 503, twice. Not judged.');
  });

  // ---- Requirement 2.3: 403 → restless ----
  it('403 → restless (Requirement 2.3)', () => {
    const j = judgements.get(URL_FORBIDDEN);
    expect(j).toBeDefined();
    expect(j!.verdict).toBe('restless');
    expect(j!.reason).toBe('Answers 403 to robots. Not judged.');
  });

  // ---- Requirement 2.4: timeout → restless ----
  it('timeout → restless (Requirement 2.4)', () => {
    const j = judgements.get(URL_TIMEOUT);
    expect(j).toBeDefined();
    expect(j!.verdict).toBe('restless');
    expect(j!.reason).toBe('No answer within 8 s. Not judged.');
  });

  // ---- Requirement 2.7 / 2.8: 2xx same-domain redirect → alive, never possessed ----
  it('2xx same-domain redirect → alive (Requirement 2.8)', () => {
    const j = judgements.get(URL_REDIRECT_SAME);
    expect(j).toBeDefined();
    expect(j!.verdict).toBe('alive');
    // Must never be classified as possessed when domain matches.
    expect(j!.verdict).not.toBe('possessed');
  });

  // ---- Requirements 2.5, 3.1, 3.2: 2xx cross-domain + low-similarity snapshot → possessed ----
  it('2xx cross-domain + low-similarity snapshot → possessed (Requirements 2.5, 3.1)', () => {
    const j = judgements.get(URL_POSSESSED);
    expect(j).toBeDefined();
    expect(j!.verdict).toBe('possessed');
    expect(j!.reason).toMatch(/^Redirects to .+; \d+% like the archived page\.$/)
  });

  it('possessed link has epitaph (Requirement 3.1)', () => {
    const j = judgements.get(URL_POSSESSED);
    expect(j).toBeDefined();
    expect(j!.epitaph).toEqual(EPITAPH);
  });

  it('possessed link has resurrection URL (Requirement 3.2)', () => {
    const j = judgements.get(URL_POSSESSED);
    expect(j).toBeDefined();
    expect(j!.resurrection).toBe(RESURRECTION_URL);
  });

  // ---- Requirement 3.1 / 3.2: dead links also get epitaph and resurrection ----
  it('dead link (DNS fail) has epitaph (Requirement 3.1)', () => {
    const j = judgements.get(URL_DNS_FAIL);
    expect(j).toBeDefined();
    expect(j!.epitaph).toEqual(EPITAPH);
  });

  it('dead link (DNS fail) has resurrection URL (Requirement 3.2)', () => {
    const j = judgements.get(URL_DNS_FAIL);
    expect(j).toBeDefined();
    expect(j!.resurrection).toBe(RESURRECTION_URL);
  });

  it('dead link (404) has epitaph (Requirement 3.1)', () => {
    const j = judgements.get(URL_NOT_FOUND);
    expect(j).toBeDefined();
    expect(j!.epitaph).toEqual(EPITAPH);
  });

  // ---- Alive links have no epitaph ----
  it('alive links have no epitaph or resurrection', () => {
    for (const url of [URL_ALIVE_A, URL_ALIVE_B, URL_REDIRECT_SAME, URL_RETRY_OK]) {
      const j = judgements.get(url);
      expect(j).toBeDefined();
      expect(j!.verdict).toBe('alive');
      expect(j!.epitaph).toBeUndefined();
      expect(j!.resurrection).toBeUndefined();
    }
  });

  // ---- Restless links have no epitaph ----
  it('restless links have no epitaph or resurrection', () => {
    for (const url of [URL_RETRY_FAIL, URL_FORBIDDEN, URL_TIMEOUT]) {
      const j = judgements.get(url);
      expect(j).toBeDefined();
      expect(j!.verdict).toBe('restless');
      expect(j!.epitaph).toBeUndefined();
      expect(j!.resurrection).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Archive notes: "never archived" vs "archive unreachable"
// ---------------------------------------------------------------------------

describe('scan — never archived vs archive unreachable', () => {
  const URL_NEVER = 'http://never-archived.example.com/';
  const URL_SILENT = 'http://archive-silent.example.com/';
  const doc = `- [a](${URL_NEVER})\n- [b](${URL_SILENT})\n`;

  const deadFetcher: Fetcher = async (url: string): Promise<Probe> => ({
    outcome: 'response',
    status: 404,
    finalUrl: url,
    text: '',
  });

  const wayback: Wayback = {
    async getArchive(url: string) {
      return { epitaph: url === URL_NEVER ? ('none' as const) : ('unavailable' as const) };
    },
    async getSnapshotText() {
      return { status: 'none' };
    },
  };

  it('passes both values through and sets distinct notes, with no resurrection', async () => {
    const judgements: Judgement[] = [];
    for await (const ev of scan(doc, 'markdown', deadFetcher, wayback)) {
      if (ev.type === 'judgement') judgements.push(ev.judgement);
    }
    const never = judgements.find(j => j.link.url === URL_NEVER)!;
    const silent = judgements.find(j => j.link.url === URL_SILENT)!;

    expect(never.verdict).toBe('dead');
    expect(never.epitaph).toBe('none');
    expect(never.resurrection).toBeUndefined();
    expect(archiveNote(never)).toBe('Lost: never archived');

    expect(silent.verdict).toBe('dead');
    expect(silent.epitaph).toBe('unavailable');
    expect(silent.resurrection).toBeUndefined();
    expect(archiveNote(silent)).toBe('The archive could not be reached. Try again.');
  });
});

// ---------------------------------------------------------------------------
// Cross-domain 2xx: archive unreachable vs. no capture
// ---------------------------------------------------------------------------

describe('scan — cross-domain redirect, archive unreachable vs. no capture', () => {
  const URL_CODEPLEX = 'http://www.codeplex.com/';
  const URL_KIKO = 'http://www.kiko.com/';
  const doc = `- [a](${URL_CODEPLEX})\n- [b](${URL_KIKO})\n`;
  const redirectingFetcher: Fetcher = async (url: string): Promise<Probe> => ({
    outcome: 'response',
    status: 200,
    finalUrl: 'https://www.microsoft.com/',
    text: 'Microsoft home page',
  });
  const wayback: Wayback = {
    async getArchive() {
      return { epitaph: 'unavailable' as const };
    },
    async getSnapshotText(url: string): Promise<SnapshotResult> {
      return url === URL_CODEPLEX ? { status: 'unavailable' } : { status: 'none' };
    },
  };

  it('archive unreachable → restless; no capture → alive (unchanged)', async () => {
    const judgements: Judgement[] = [];
    for await (const ev of scan(doc, 'markdown', redirectingFetcher, wayback)) {
      if (ev.type === 'judgement') judgements.push(ev.judgement);
    }
    const codeplex = judgements.find(j => j.link.url === URL_CODEPLEX)!;
    const kiko = judgements.find(j => j.link.url === URL_KIKO)!;
    expect(codeplex.verdict).toBe('restless');
    expect(codeplex.reason).toBe(
      'Redirects to microsoft.com; the archive could not be reached to compare. Not judged.',
    );
    expect(kiko.verdict).toBe('alive');
    expect(kiko.reason).toBe('Redirects to microsoft.com; no archived copy to compare.');
  });
});
