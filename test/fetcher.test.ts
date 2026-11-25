import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetcher } from '../src/net/fetcher.ts';

// Unit tests for the fetcher's DNS-over-HTTPS confirmation (task 14.1).

const DOH = 'https://cloudflare-dns.com/dns-query';

function stub(doh: () => Promise<Response>) {
  const spy = vi.fn(async (input: unknown) => {
    const u = String(input);
    if (u.startsWith(DOH)) return doh();
    throw new TypeError('internal error; reference = abc');
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetcher DNS confirmation', () => {
  it('sets dnsFailure when DoH answers Status 3', async () => {
    const spy = stub(async () => new Response(JSON.stringify({ Status: 3 })));
    const p = await fetcher('http://gone.example.com/');
    expect(p.outcome).toBe('network-error');
    expect(p.dnsFailure).toBe(true);
    const call = spy.mock.calls.find(c => String(c[0]).startsWith(DOH))!;
    expect(String(call[0])).toContain('name=gone.example.com&type=A');
  });

  it('does not set dnsFailure when DoH answers Status 0 with an A record', async () => {
    stub(async () => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '203.0.113.9' }] })));
    const p = await fetcher('http://up.example.com/');
    expect(p.outcome).toBe('network-error');
    expect(p.dnsFailure).toBeUndefined();
  });

  it('does not set dnsFailure when DoH throws', async () => {
    stub(async () => {
      throw new Error('doh down');
    });
    const p = await fetcher('http://up.example.com/');
    expect(p.outcome).toBe('network-error');
    expect(p.dnsFailure).toBeUndefined();
  });

  it('530 + NXDOMAIN is a confirmed DNS failure', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      const u = String(input);
      calls.push(u);
      if (u.startsWith(DOH)) return new Response(JSON.stringify({ Status: 3 }));
      return new Response('error code: 1016', { status: 530 });
    });
    const p = await fetcher('http://www.dmoz.org/');
    expect(p.outcome).toBe('network-error');
    expect(p.dnsFailure).toBe(true);
    expect(calls.filter(c => !c.startsWith(DOH))).toHaveLength(1);
  });

  it('530 + NOERROR with no A and no AAAA is a confirmed DNS failure', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (String(input).startsWith(DOH)) return new Response(JSON.stringify({ Status: 0 }));
      return new Response('', { status: 530 });
    });
    const p = await fetcher('http://www.dmoz.org/');
    expect(p.dnsFailure).toBe(true);
  });

  it('530 + A record present stays a 530 response and is not retried (subrequest budget)', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (String(input).startsWith(DOH)) {
        return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '203.0.113.9' }] }));
      }
      return new Response('', { status: 530 });
    });
    const p = await fetcher('http://www.dmoz.org/');
    expect(p).toMatchObject({ outcome: 'response', status: 530 });
    expect(p.dnsFailure).toBeUndefined();
    expect(p.noRetry).toBe(true);
  });

  it('530 + DoH failure stays a 530 response', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (String(input).startsWith(DOH)) throw new Error('doh down');
      return new Response('', { status: 530 });
    });
    const p = await fetcher('http://www.dmoz.org/');
    expect(p).toMatchObject({ outcome: 'response', status: 530 });
    expect(p.dnsFailure).toBeUndefined();
  });

  it('530 with skipDns makes no DoH query', async () => {
    const spy = vi.fn(async () => new Response('', { status: 530 }));
    vi.stubGlobal('fetch', spy);
    const p = await fetcher('http://www.dmoz.org/', { timeoutMs: 8_000, maxBytes: 1_000, skipDns: true });
    expect(p).toMatchObject({ outcome: 'response', status: 530 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('530 on a redirect hop checks that hop host', async () => {
    const dohNames: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      const u = String(input);
      if (u.startsWith(DOH)) {
        dohNames.push(new URL(u).searchParams.get('name')!);
        return new Response(JSON.stringify({ Status: 3 }));
      }
      if (u === 'http://old.example.com/') {
        return new Response(null, { status: 301, headers: { Location: 'http://new.example.net/' } });
      }
      return new Response('', { status: 530 });
    });
    const p = await fetcher('http://old.example.com/');
    expect(p.dnsFailure).toBe(true);
    expect(dohNames).toEqual(['new.example.net']);
  });

  it('does not run DoH for guard rejections', async () => {
    const spy = stub(async () => new Response(JSON.stringify({ Status: 3 })));
    const p = await fetcher('http://localhost/');
    expect(p.outcome).toBe('network-error');
    expect(p.dnsFailure).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('fetcher releases unread bodies', () => {
  /** A response with a stream body that records whether it was cancelled. */
  function tracked(status: number, headers: Record<string, string> = {}) {
    const state = { cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode('unread body'));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { response: new Response(body, { status, headers }), state };
  }

  it('cancels the body of every 3xx hop', async () => {
    const hops: Array<ReturnType<typeof tracked>> = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      const u = String(input);
      if (u === 'http://a.example.com/') {
        const h = tracked(301, { Location: 'http://b.example.com/' });
        hops.push(h);
        return h.response;
      }
      if (u === 'http://b.example.com/') {
        const h = tracked(302, { Location: 'http://c.example.com/' });
        hops.push(h);
        return h.response;
      }
      return new Response('done', { status: 200 });
    });
    const p = await fetcher('http://a.example.com/');
    expect(p).toMatchObject({ outcome: 'response', status: 200, text: 'done' });
    expect(hops).toHaveLength(2);
    expect(hops.every(h => h.state.cancelled)).toBe(true);
  });

  it('cancels the 3xx body when giving up on a redirect without Location', async () => {
    const h = tracked(302);
    vi.stubGlobal('fetch', async () => h.response);
    const p = await fetcher('http://a.example.com/');
    expect(p.outcome).toBe('network-error');
    expect(h.state.cancelled).toBe(true);
  });
});