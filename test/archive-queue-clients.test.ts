import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArchiveQueue } from '../src/net/archive-queue.js';
import { createFetcher } from '../src/net/fetcher.js';
import { createWaybackClient } from '../src/net/wayback.js';
import { FakeClock } from './fixtures/fake-clock.js';

// Task 18.3: the Wayback client and the fetcher wrapper send all archive traffic through one queue.

afterEach(() => {
  vi.unstubAllGlobals();
});

const CDX = JSON.stringify([
  ['timestamp', 'length'],
  ['20120101000000', '5000'],
  ['20120201000000', '5000'],
]);

/** Set when two archive requests were in flight at once. */
let overlap = false;

interface Call {
  url: string;
  at: number;
}

/** Stub global fetch: records each call with the fake time, answers through `answer`. */
function stubFetch(clock: FakeClock, answer: (url: string, n: number) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  let inFlight = 0;
  overlap = false;
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    calls.push({ url, at: clock.now() });
    inFlight += 1;
    try {
      if (url.includes('archive.org') && inFlight > 1) overlap = true;
      return await answer(url, calls.length);
    } finally {
      inFlight -= 1;
    }
  });
  return calls;
}

const html = (text: string): Response => new Response(`<p>${text}</p>`, { status: 200 });

describe('Wayback client through the queue', () => {
  it('spaces CDX requests for different URLs by the gap', async () => {
    const clock = new FakeClock();
    const queue = createArchiveQueue({ minGapMs: 1000, clock });
    const calls = stubFetch(clock, () => new Response(CDX));
    const w = createWaybackClient({ queue });
    const all = Promise.all([
      w.getArchive('https://q1.example.com/a'),
      w.getArchive('https://q2.example.com/a'),
      w.getArchive('https://q3.example.com/a'),
    ]);
    await clock.advance(3_000);
    await all;
    expect(calls.map(c => c.at)).toEqual([0, 1000, 2000]);
    expect(calls.every(c => c.url.includes('/cdx/'))).toBe(true);
    expect(overlap).toBe(false);
  });

  it('sends the CDX request, the id_ body and the availability API through the same queue', async () => {
    const clock = new FakeClock();
    const queue = createArchiveQueue({ minGapMs: 1000, clock });
    const calls = stubFetch(clock, url =>
      url.includes('/cdx/')
        ? new Response(CDX)
        : url.includes('/wayback/available')
          ? new Response(JSON.stringify({ archived_snapshots: {} }))
          : html('old page words'),
    );
    const w = createWaybackClient({ queue });
    const all = Promise.all([
      w.getSnapshotText('https://q4.example.com/a'),
      w.getClosestSnapshot!('https://q5.example.com/a', '2020-01-01'),
    ]);
    await clock.advance(5_000);
    const [snap, closest] = await all;
    expect(snap.status).toBe('text');
    expect(closest).toEqual({ status: 'none' });
    expect(calls.map(c => c.at)).toEqual([0, 1000, 2000]);
    expect(overlap).toBe(false);
    expect(calls.some(c => c.url.includes('/wayback/available'))).toBe(true);
    expect(calls.some(c => c.url.includes('id_/'))).toBe(true);
  });

  it('a 429 with Retry-After holds back a request that was already waiting', async () => {
    const clock = new FakeClock();
    const queue = createArchiveQueue({ minGapMs: 100, clock });
    const calls = stubFetch(clock, (url, n) =>
      n === 1 ? new Response('slow', { status: 429, headers: { 'Retry-After': '4' } }) : new Response(CDX),
    );
    const w = createWaybackClient({ queue });
    const a = w.getArchive('https://q6.example.com/a');
    const b = w.getArchive('https://q7.example.com/a');
    await clock.advance(3_999);
    expect(calls).toHaveLength(1);
    await clock.advance(1_000);
    await Promise.all([a, b]);
    // b was queued before a's retry, and both wait for the 4 s Retry-After.
    expect(calls[1]!.url).toContain('q7.example.com');
    expect(calls[1]!.at).toBe(4_000);
    expect(calls[2]!.url).toContain('q6.example.com');
    expect(calls[2]!.at).toBe(4_100);
  });

  it('a 503 with Retry-After also holds back the queue, without a retry', async () => {
    const clock = new FakeClock();
    const queue = createArchiveQueue({ minGapMs: 0, clock });
    const calls = stubFetch(clock, (url, n) =>
      n === 1 ? new Response('busy', { status: 503, headers: { 'Retry-After': '2' } }) : new Response(CDX),
    );
    const w = createWaybackClient({ queue });
    const a = w.getArchive('https://q8.example.com/a');
    const b = w.getArchive('https://q9.example.com/a');
    await clock.advance(5_000);
    expect((await a).epitaph).toBe('unavailable');
    expect(typeof (await b).epitaph).toBe('object');
    expect(calls.map(c => c.at)).toEqual([0, 2_000]);
  });

  it('times a request from its start, so queue waiting does not eat the 10 s limit', async () => {
    const clock = new FakeClock();
    const queue = createArchiveQueue({ minGapMs: 0, clock });
    queue.penalize(9_000);
    const calls = stubFetch(clock, () => new Response(CDX));
    const p = createWaybackClient({ queue }).getArchive('https://q10.example.com/a');
    await clock.advance(9_000);
    expect(typeof (await p).epitaph).toBe('object');
    expect(calls[0]!.at).toBe(9_000);
  });
});

describe('fetcher wrapper through the queue', () => {
  const ok = (): Response => html('hello there');

  it('queues a link whose host is web.archive.org and archive.org', async () => {
    const clock = new FakeClock();
    const queue = createArchiveQueue({ minGapMs: 1000, clock });
    const calls = stubFetch(clock, ok);
    const f = createFetcher({ archiveQueue: queue });
    const all = Promise.all([
      f('https://web.archive.org/web/2020/http://a.example/'),
      f('https://archive.org/details/thing'),
      f('https://web.archive.org/web/2021/http://b.example/'),
    ]);
    await clock.advance(3_000);
    const probes = await all;
    expect(probes.every(p => p.outcome === 'response' && p.status === 200)).toBe(true);
    expect(calls.map(c => c.at)).toEqual([0, 1000, 2000]);
  });

  it('does not queue other hosts', async () => {
    const clock = new FakeClock();
    const queue = createArchiveQueue({ minGapMs: 1000, clock });
    queue.penalize(5_000);
    const calls = stubFetch(clock, ok);
    const f = createFetcher({ archiveQueue: queue });
    const p = f('https://other.example.com/');
    await clock.advance(0);
    expect((await p).outcome).toBe('response');
    expect(calls.map(c => c.at)).toEqual([0]);
  });

  it('queues a redirect hop that lands on the archive, and keeps the redirect limit', async () => {
    const clock = new FakeClock();
    const queue = createArchiveQueue({ minGapMs: 1000, clock });
    const calls = stubFetch(clock, url =>
      url.startsWith('https://old.example.com/')
        ? new Response('', { status: 301, headers: { Location: 'https://web.archive.org/web/2020/http://old.example.com/' } })
        : ok(),
    );
    // Another archive request started at t=0 occupies the first slot.
    const busy = queue.run(async () => {});
    const f = createFetcher({ archiveQueue: queue });
    const p = f('https://old.example.com/start');
    await clock.advance(2_000);
    const probe = await p;
    await busy;
    expect(probe.outcome).toBe('response');
    expect(probe.finalUrl).toBe('https://web.archive.org/web/2020/http://old.example.com/');
    // First hop is not archive traffic and goes out at once; the archive hop waits for the gap.
    expect(calls.map(c => c.at)).toEqual([0, 1000]);
  });

  it('still stops after 5 redirects, each archive hop queued', async () => {
    const clock = new FakeClock();
    const queue = createArchiveQueue({ minGapMs: 1000, clock });
    const calls = stubFetch(clock, url => {
      const n = Number(url.split('/').pop());
      return new Response('', { status: 302, headers: { Location: `https://web.archive.org/web/${n + 1}` } });
    });
    const p = createFetcher({ archiveQueue: queue })('https://web.archive.org/web/0');
    await clock.advance(10_000);
    const probe = await p;
    expect(probe).toEqual({ outcome: 'network-error', text: 'too many redirects' });
    expect(calls).toHaveLength(6);
    expect(calls.map(c => c.at)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
  });

  it('still blocks a redirect to a forbidden host', async () => {
    const clock = new FakeClock();
    const queue = createArchiveQueue({ minGapMs: 1000, clock });
    const calls = stubFetch(clock, () => new Response('', { status: 302, headers: { Location: 'http://localhost/admin' } }));
    const p = createFetcher({ archiveQueue: queue })('https://web.archive.org/web/0');
    await clock.advance(1_000);
    const probe = await p;
    expect(probe.blocked).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('does not count queue waiting against the call timeout', async () => {
    const clock = new FakeClock();
    const queue = createArchiveQueue({ minGapMs: 0, clock });
    queue.penalize(20_000);
    stubFetch(clock, ok);
    const p = createFetcher({ archiveQueue: queue })('https://web.archive.org/web/2020/http://a.example/', {
      timeoutMs: 8_000,
      maxBytes: 524_288,
    });
    await clock.advance(20_000);
    expect((await p).outcome).toBe('response');
  });

  it('times out a hop that hangs, counted from its start', async () => {
    const clock = new FakeClock();
    const queue = createArchiveQueue({ minGapMs: 0, clock });
    queue.penalize(20_000);
    vi.stubGlobal('fetch', (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    );
    const p = createFetcher({ archiveQueue: queue })('https://web.archive.org/web/2020/http://a.example/', {
      timeoutMs: 8_000,
      maxBytes: 524_288,
    });
    await clock.advance(27_999);
    await clock.advance(1);
    expect(await p).toEqual({ outcome: 'timeout' });
  });

  it('a 429 with Retry-After on an archive link holds back the next archive request', async () => {
    const clock = new FakeClock();
    const queue = createArchiveQueue({ minGapMs: 100, clock });
    const calls = stubFetch(clock, (url, n) =>
      n === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '3' } }) : new Response(CDX),
    );
    const f = createFetcher({ archiveQueue: queue });
    const w = createWaybackClient({ queue });
    const a = f('https://web.archive.org/web/2020/http://a.example/');
    const b = w.getArchive('https://q11.example.com/a');
    await clock.advance(5_000);
    expect((await a).status).toBe(429);
    await b;
    expect(calls.map(c => c.at)).toEqual([0, 3_000]);
  });
});
