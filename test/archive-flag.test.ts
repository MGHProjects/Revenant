import { afterEach, describe, expect, it, vi } from 'vitest';
import { judgeLink } from '../src/net/judge-link.js';
import { createWaybackClient } from '../src/net/wayback.js';
import type { Fetcher, Link, Probe } from '../src/core/types.js';

// Task 16.3: archiveUnavailable is set only when the archive's failure changed the result.
afterEach(() => {
  vi.unstubAllGlobals();
});

const noSleep = async (): Promise<void> => {};
const linkOf = (url: string): Link => ({ url, spans: [{ start: 0, end: url.length }] });
const fixed = (probe: Probe): Fetcher => async () => probe;
const CDX_OK = JSON.stringify([['timestamp', 'length'], ['20120101000000', '5000'], ['20120201000000', '5000']]);

function stubCdx(cdx: () => Response): void {
  vi.stubGlobal('fetch', async (input: unknown) =>
    String(input).includes('/cdx/') ? cdx() : new Response('<p>old words</p>', { status: 200 }));
}

const judge = (url: string, probe: Probe) =>
  judgeLink(linkOf(url), { fetcher: fixed(probe), wayback: createWaybackClient(), sleep: noSleep });

const down = (): Response => new Response('down', { status: 500 });
const dead: Probe = { outcome: 'response', status: 404, text: '' };

describe('archiveUnavailable flag', () => {
  it('dead + archive unreachable: set', async () => {
    stubCdx(down);
    const j = await judge('http://a-gone.example.com/', dead);
    expect(j.verdict).toBe('dead');
    expect(j.archiveUnavailable).toBe(true);
  });

  it('dead + never archived: not set', async () => {
    stubCdx(() => new Response('[]', { status: 200 }));
    const j = await judge('http://b-gone.example.com/', dead);
    expect(j.epitaph).toBe('none');
    expect(j.archiveUnavailable).toBeUndefined();
  });

  it('dead + archive answered: not set', async () => {
    stubCdx(() => new Response(CDX_OK, { status: 200 }));
    const j = await judge('http://c-gone.example.com/', dead);
    expect(j.archiveUnavailable).toBeUndefined();
  });

  it('cross-domain 2xx + snapshot unavailable (restless): set', async () => {
    stubCdx(down);
    const j = await judge('http://d-moved.example.com/', {
      outcome: 'response', status: 200, finalUrl: 'http://other-domain.test/', text: '<p>ads</p>',
    });
    expect(j.verdict).toBe('restless');
    expect(j.archiveUnavailable).toBe(true);
  });

  it.each([
    ['403', { outcome: 'response', status: 403, text: '' } as Probe],
    ['429', { outcome: 'response', status: 429, text: '' } as Probe],
    ['timeout', { outcome: 'timeout' } as Probe],
    ['connection error', { outcome: 'network-error', text: 'reset' } as Probe],
    ['persistent 5xx', { outcome: 'response', status: 503, text: '' } as Probe],
  ])('restless from the site (%s): not set', async (_name, probe) => {
    stubCdx(down);
    const j = await judge('http://e-site.example.com/', probe);
    expect(j.verdict).toBe('restless');
    expect(j.archiveUnavailable).toBeUndefined();
  });

  it('restless from the guard: not set', async () => {
    stubCdx(down);
    const j = await judge('http://localhost/', dead);
    expect(j.verdict).toBe('restless');
    expect(j.archiveUnavailable).toBeUndefined();
  });

  it('alive same-domain 2xx: not set', async () => {
    stubCdx(down);
    const j = await judge('http://f-fine.example.com/', {
      outcome: 'response', status: 200, finalUrl: 'http://f-fine.example.com/', text: '<p>hi</p>',
    });
    expect(j.verdict).toBe('alive');
    expect(j.archiveUnavailable).toBeUndefined();
  });
});