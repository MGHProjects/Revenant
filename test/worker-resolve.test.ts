import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/worker/index.ts';

// Worker-level tests for POST /api/resolve with kind 'url' (task 15.7).

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function resolve(input: string): Promise<Response> {
  return app.request('/api/resolve', {
    method: 'POST',
    body: JSON.stringify({ input, kind: 'url' }),
  });
}

describe('POST /api/resolve (url)', () => {
  it('rejects a redirect to a private IP and never contacts it', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { Location: 'http://10.0.0.1/admin' } });
    });
    const res = await resolve('https://example.com/start');
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/^That address is not allowed: /);
    expect(calls).toEqual(['https://example.com/start']);
  });

  it('truncates a body over 512 KB instead of failing', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('a'.repeat(600_000), { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );
    const res = await resolve('https://example.com/big.md');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; kind: string };
    expect(body.source.length).toBe(524_288);
    expect(body.kind).toBe('markdown');
  });

  it('detects html from the Content-Type header', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('<p>hi</p>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    );
    const body = (await (await resolve('https://example.com/')).json()) as { kind: string };
    expect(body.kind).toBe('html');
  });

  it('times out when the body never finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return new Response(stream, { status: 200 });
    });
    const p = Promise.resolve(resolve('https://example.com/slow'));
    await vi.advanceTimersByTimeAsync(8_500);
    const res = await p;
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Could not load that address: no answer within 8 s.' });
  });

  it('a 404 page gives 422 with the status', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    const res = await resolve('https://example.com/missing');
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Could not load that address: it answered 404.' });
  });

  it('an exception inside the handler gives 500 with no stack', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      body: null,
      headers: {
        get() {
          throw new Error('secret internal detail');
        },
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    const res = await resolve('https://example.com/');
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({ error: 'Internal error' });
    expect(raw).not.toMatch(/secret|stack|\.ts/);
  });

  it('invalid JSON stays 400', async () => {
    const res = await app.request('/api/resolve', { method: 'POST', body: '{' });
    expect(res.status).toBe(400);
  });
});
