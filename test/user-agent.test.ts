import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetcher } from '../src/net/fetcher.ts';
import { createWaybackClient } from '../src/net/wayback.ts';
import { USER_AGENT } from '../src/net/user-agent.ts';

// Every outbound request carries the one User-Agent constant.

afterEach(() => {
  vi.unstubAllGlobals();
});

function agentOf(init: unknown): string | undefined {
  const h = (init as { headers?: Record<string, string> } | undefined)?.headers;
  return h?.['User-Agent'];
}

describe('User-Agent', () => {
  it('has the agreed value', () => {
    expect(USER_AGENT).toBe('Revenant/1.0 (+https://revenant.mgh-web.workers.dev)');
  });

  it('is sent by the fetcher on every hop', async () => {
    const seen: Array<string | undefined> = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: unknown) => {
      seen.push(agentOf(init));
      return String(input) === 'http://a.example.com/'
        ? new Response(null, { status: 301, headers: { Location: 'http://b.example.net/' } })
        : new Response('ok', { status: 200 });
    });
    await fetcher('http://a.example.com/', { timeoutMs: 8_000, maxBytes: 1_000 });
    expect(seen).toEqual([USER_AGENT, USER_AGENT]);
  });

  it('is sent by the Wayback client on the CDX and id_ requests', async () => {
    const seen: Array<{ url: string; agent: string | undefined }> = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: unknown) => {
      const url = String(input);
      seen.push({ url, agent: agentOf(init) });
      return url.includes('/cdx/')
        ? new Response(JSON.stringify([['timestamp', 'length'], ['20200101000000', '1000']]))
        : new Response('<p>old page</p>');
    });
    await createWaybackClient().getSnapshotText('https://ua-check.example.com/page');
    expect(seen.some(s => s.url.includes('/cdx/'))).toBe(true);
    expect(seen.some(s => s.url.includes('id_/'))).toBe(true);
    expect(seen.every(s => s.agent === USER_AGENT)).toBe(true);
  });
});
