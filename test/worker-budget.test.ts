import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/worker/index.ts';
import { fetcher } from '../src/net/fetcher.js';
import { PER_URL_WORST_CASE, WORKER_SUBREQUEST_LIMIT, judgeLink } from '../src/net/judge-link.js';
import { createWaybackClient } from '../src/net/wayback.js';
import type { Link } from '../src/core/types.js';

// Task 15.8 (B6): the free plan allows 50 subrequests per invocation. Every fetch counts, and so
// does every Cache API match/put. These tests count both while forcing each worst path.

const DOH = 'https://cloudflare-dns.com/dns-query';
const CDX_OK = JSON.stringify([
  ['timestamp', 'length'],
  ['20120101000000', '5000'],
  ['20120201000000', '5000'],
]);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const noSleep = async (): Promise<void> => {};
const linkOf = (url: string): Link => ({ url, spans: [] }) as unknown as Link;

type End = 'throw' | '530' | '503' | '404' | 'cross-2xx';
interface Scenario {
  /** What the 6th request of each attempt (the end of a 5-redirect chain) does. */
  end: (attempt: number) => End;
  /** DoH answers by query type. */
  doh: { A: unknown; AAAA: unknown };
}

/**
 * Stub global fetch and caches. Each origin is `http://{host}/` with a 5-redirect chain
 * ending on another domain ("x-" + host); `scenario.end` decides how the sixth request ends.
 */
function stubWorld(scenarios: Record<string, Scenario>) {
  const counts = { fetch: 0, cache: 0 };
  const attempts: Record<string, number> = {};
  const log: string[] = [];
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async () => {
        counts.cache += 1;
        return undefined;
      },
      put: async () => {
        counts.cache += 1;
      },
      delete: async () => {
        counts.cache += 1;
        return false;
      },
    }),
  });
  const cdxSeen = new Set<string>();
  const idSeen = new Set<string>();
  vi.stubGlobal('fetch', async (input: unknown) => {
    const u = String(input);
    counts.fetch += 1;
    log.push(u);
    if (u.startsWith(DOH)) {
      const q = new URL(u).searchParams;
      const host = q.get('name')!.replace(/^x-/, '');
      return new Response(JSON.stringify(scenarios[host]!.doh[q.get('type') as 'A' | 'AAAA']));
    }
    if (u.includes('archive.org')) {
      const first = u.includes('/cdx/') ? !cdxSeen.has(u) : !idSeen.has(u);
      (u.includes('/cdx/') ? cdxSeen : idSeen).add(u);
      // Worst case: the first answer to CDX and to id_ is a 429, the retry succeeds.
      if (first) return new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } });
      return new Response(u.includes('/cdx/') ? CDX_OK : '<p>Documentation for the maintainers: install, configure and release the library.</p>');
    }
    const url = new URL(u);
    const host = url.hostname.replace(/^x-/, '');
    const sc = scenarios[host]!;
    const hop = Number(url.pathname.slice(1) || '0');
    if (url.hostname.startsWith('x-')) {
      attempts[host] = (attempts[host] ?? 0) + 1;
      switch (sc.end(attempts[host]!)) {
        case 'throw':
          throw new TypeError('network connection lost');
        case '530':
          return new Response('error code: 1016', { status: 530 });
        case '503':
          return new Response('busy', { status: 503 });
        case '404':
          return new Response('gone', { status: 404 });
        case 'cross-2xx':
          return new Response('<p>buy cheap pills casino poker bonus click here now</p>');
      }
    }
    // hops 0..3 redirect to the next path; hop 4 redirects to the other domain: 5 redirects.
    const next = hop < 4 ? `http://${host}/${hop + 1}` : `http://x-${host}/end`;
    return new Response('moved', { status: 302, headers: { Location: next } });
  });
  return { counts, log };
}

const A_ONLY = { A: { Status: 0 }, AAAA: { Status: 3 } };

async function judgeOne(host: string, sc: Scenario): Promise<{ total: number; verdict: string }> {
  const { counts } = stubWorld({ [host]: sc });
  const j = await judgeLink(
    linkOf(`http://${host}/`),
    { fetcher, wayback: createWaybackClient(), sleep: noSleep },
    { textCap: 65_536 },
  );
  return { total: counts.fetch + counts.cache, verdict: j.verdict };
}

describe('Worker subrequest budget', () => {
  it('3 x the per-URL worst case fits in the 50-subrequest limit', () => {
    expect(PER_URL_WORST_CASE).toBe(16);
    expect(3 * PER_URL_WORST_CASE).toBeLessThanOrEqual(WORKER_SUBREQUEST_LIMIT);
  });

  it('5xx twice then a cross-domain 2xx, 429 on CDX and id_: exactly the worst case', async () => {
    const r = await judgeOne('w-worst.example', {
      end: n => (n === 1 ? '503' : 'cross-2xx'),
      doh: A_ONLY,
    });
    expect(r.verdict).toBe('possessed');
    expect(r.total).toBe(PER_URL_WORST_CASE); // 6 + 6 + CDX 2 + id_ 2, no cache calls
  });

  it('thrown fetch on the 6th hop with two DoH queries and a confirmed failure', async () => {
    const r = await judgeOne('w-throw.example', { end: () => 'throw', doh: A_ONLY });
    expect(r.verdict).toBe('dead');
    expect(r.total).toBe(6 + 2 + 2); // hops + DoH A and AAAA + CDX with a 429 retry
  });

  it('530 with two unconfirmed DoH queries is not retried and skips Wayback', async () => {
    const r = await judgeOne('w-530.example', {
      end: () => '530',
      doh: { A: { Status: 0 }, AAAA: { Status: 0, Answer: [{ type: 28, data: '::1' }] } },
    });
    expect(r.verdict).toBe('restless');
    expect(r.total).toBe(6 + 2);
  });

  it('5xx twice then 404: retry plus the CDX lookup only', async () => {
    const r = await judgeOne('w-404.example', {
      end: n => (n === 1 ? '503' : '404'),
      doh: A_ONLY,
    });
    expect(r.verdict).toBe('dead');
    expect(r.total).toBe(6 + 6 + 2);
  });

  it('three worst-case URLs in one POST /api/scan stay at or under 50', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const sc: Scenario = { end: n => (n === 1 ? '503' : 'cross-2xx'), doh: A_ONLY };
    const hosts = ['w-a.example', 'w-b.example', 'w-c.example'];
    const { counts } = stubWorld(Object.fromEntries(hosts.map(h => [h, sc])));
    const p = Promise.resolve(
      app.request('/api/scan', {
        method: 'POST',
        body: JSON.stringify({ urls: hosts.map(h => `http://${h}/`) }),
      }),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    const res = await p;
    expect(res.status).toBe(200);
    expect(counts.fetch + counts.cache).toBe(3 * PER_URL_WORST_CASE);
    expect(counts.fetch + counts.cache).toBeLessThanOrEqual(WORKER_SUBREQUEST_LIMIT);
    expect(counts.cache).toBe(0);
  });
});
