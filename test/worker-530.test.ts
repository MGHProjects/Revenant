import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/worker/index.ts';

// Worker-level tests for the HTTP 530 DNS path (task 14.9).

const DOH = 'https://cloudflare-dns.com/dns-query';
const TARGET = 'http://www.dmoz.org/';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function stub(dohBody: unknown) {
  const targetCalls: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const u = String(input);
    if (u.startsWith(DOH)) return new Response(JSON.stringify(dohBody));
    if (u.includes('archive.org')) return new Response('[]', { status: 200 });
    targetCalls.push(u);
    return new Response('error code: 1016', { status: 530 });
  });
  return targetCalls;
}

async function scan(): Promise<{ verdict: string; reason: string }> {
  const p = Promise.resolve(
    app.request('/api/scan', {
      method: 'POST',
      body: JSON.stringify({ urls: [TARGET] }),
    }),
  );
  await vi.advanceTimersByTimeAsync(3_000);
  const res = await p;
  const { judgements } = (await res.json()) as { judgements: Array<{ verdict: string; reason: string }> };
  return judgements[0]!;
}

describe('POST /api/scan with HTTP 530', () => {
  it('a confirmed 530 is dead and fetched once (no retry)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const targetCalls = stub({ Status: 3 });
    const j = await scan();
    expect(j.verdict).toBe('dead');
    expect(j.reason).toBe('The domain no longer resolves.');
    expect(targetCalls).toHaveLength(1);
  });

  it('an unconfirmed 530 (A record present) is retried once, then restless', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const targetCalls = stub({ Status: 0, Answer: [{ type: 1, data: '203.0.113.9' }] });
    const j = await scan();
    expect(j.verdict).toBe('restless');
    expect(j.reason).toBe('Answers 530, twice. Not judged.');
    expect(targetCalls).toHaveLength(2);
  });
});
