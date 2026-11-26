import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetcher } from '../src/net/fetcher.js';
import { judgeLink } from '../src/net/judge-link.js';
import { createWaybackClient } from '../src/net/wayback.js';
import type { Link } from '../src/core/types.js';

// Task 18.2: a rename (known list or same name, other suffix) is decided without the archive.
// The worst-case budget (PER_URL_WORST_CASE) is still covered by worker-budget.test.ts.

afterEach(() => {
  vi.unstubAllGlobals();
});

const linkOf = (url: string): Link => ({ url, spans: [] }) as unknown as Link;
const PAGE = '<p>' + 'Welcome to the new home of the service, sign in or browse the catalogue. '.repeat(5) + '</p>';

async function run(from: string, to: string): Promise<{ verdict: string; reason: string; wayback: string[] }> {
  const wayback: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const u = String(input);
    if (u.includes('archive.org')) {
      wayback.push(u);
      return new Response('down', { status: 503 });
    }
    if (u === from) return new Response(null, { status: 301, headers: { location: to } });
    return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
  });
  const j = await judgeLink(linkOf(from), {
    fetcher,
    wayback: createWaybackClient(),
    sleep: async () => {},
  });
  return { verdict: j.verdict, reason: j.reason, wayback };
}

describe('judgeLink and renames', () => {
  it('a same-name redirect makes no Wayback request', async () => {
    const r = await run('http://www.exercism.io/', 'https://exercism.org/');
    expect(r.verdict).toBe('alive');
    expect(r.reason).toBe('Moved to exercism.org.');
    expect(r.wayback).toEqual([]);
  });

  it('a known rename makes no Wayback request', async () => {
    const r = await run('https://mobile.twitter.com/jack/status/20', 'https://x.com/jack/status/20');
    expect(r.verdict).toBe('alive');
    expect(r.reason).toBe('Moved to x.com.');
    expect(r.wayback).toEqual([]);
  });

  it('another domain still asks the archive', async () => {
    const r = await run('http://geocities.com/', 'https://www.yahoo.com/');
    expect(r.wayback.length).toBeGreaterThan(0);
  });
});
