import { describe, expect, it, vi } from 'vitest';
import { confirmNoDns } from '../src/net/dns.ts';

// Unit tests for the shared DNS-over-HTTPS confirmation (task 14.9).

type Reply = { status?: number; body?: unknown; throws?: boolean };

/** Stub fetch: replies are consumed in order, one per DoH query. */
function doh(...replies: Reply[]) {
  const queue = [...replies];
  return vi.fn(async (_input: unknown, _init?: unknown) => {
    const r = queue.shift() ?? { throws: true };
    if (r.throws) throw new Error('doh down');
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('confirmNoDns', () => {
  it('NXDOMAIN on the A query is confirmed after one query', async () => {
    const f = doh({ body: { Status: 3 } });
    expect(await confirmNoDns('gone.example.com', { fetch: f })).toEqual({ confirmed: true, queries: 1 });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('https://cloudflare-dns.com/dns-query?name=gone.example.com&type=A');
    expect((init as RequestInit).headers).toMatchObject({ accept: 'application/dns-json' });
  });

  it('NOERROR with no A and no AAAA answer is confirmed after two queries', async () => {
    const f = doh({ body: { Status: 0 } }, { body: { Status: 0 } });
    expect(await confirmNoDns('empty.example.com', { fetch: f })).toEqual({ confirmed: true, queries: 2 });
  });

  it('CNAME-only answers count as no record', async () => {
    const cname = { Status: 0, Answer: [{ type: 5, data: 'x.example.net.' }] };
    const f = doh({ body: cname }, { body: cname });
    expect((await confirmNoDns('alias.example.com', { fetch: f })).confirmed).toBe(true);
  });

  it('an A record is not confirmed and skips AAAA', async () => {
    const f = doh({ body: { Status: 0, Answer: [{ type: 1, data: '203.0.113.9' }] } });
    expect(await confirmNoDns('up.example.com', { fetch: f })).toEqual({ confirmed: false, queries: 1 });
  });

  it('an AAAA record is not confirmed', async () => {
    const f = doh({ body: { Status: 0 } }, { body: { Status: 0, Answer: [{ type: 28, data: '::1' }] } });
    expect(await confirmNoDns('v6.example.com', { fetch: f })).toEqual({ confirmed: false, queries: 2 });
  });

  it('SERVFAIL, non-2xx and thrown errors are not confirmed', async () => {
    expect((await confirmNoDns('a.example.com', { fetch: doh({ body: { Status: 2 } }) })).confirmed).toBe(false);
    expect((await confirmNoDns('a.example.com', { fetch: doh({ status: 503 }) })).confirmed).toBe(false);
    expect((await confirmNoDns('a.example.com', { fetch: doh({ throws: true }) })).confirmed).toBe(false);
    expect((await confirmNoDns('a.example.com', { fetch: doh({ body: { Status: 0 } }, { throws: true }) })).confirmed).toBe(false);
  });

  it('an empty host makes no query', async () => {
    const f = doh();
    expect(await confirmNoDns('', { fetch: f })).toEqual({ confirmed: false, queries: 0 });
    expect(f).not.toHaveBeenCalled();
  });
});
