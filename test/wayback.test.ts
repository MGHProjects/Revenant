/**
 * Unit tests for the Wayback Machine client — Requirements 3.1, 3.2, 3.3, 3.4
 *
 * Uses vi.stubGlobal('fetch', ...) to intercept network calls without real I/O.
 *
 * Covers:
 *   - CDX success: first + last timestamps parsed to ISO dates
 *   - Resurrection URL format: web/{timestamp}/{url}, no id_
 *   - Snapshot text fetch: id_ URL used, HTML stripped to visible text
 *   - 429 back-off: Retry-After header honoured, one retry succeeds
 *   - CDX unreachable / error: returns 'unavailable'
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWaybackClient } from '../src/net/wayback.js';
import type { Wayback } from '../src/core/types.js';

const epitaphOf = async (c: Wayback, u: string) => (await c.getArchive(u)).epitaph;
const resurrectionOf = async (c: Wayback, u: string) => (await c.getArchive(u)).resurrection;

// ---------------------------------------------------------------------------
// CDX response helpers
// ---------------------------------------------------------------------------

/** CDX body from explicit [timestamp, length] rows (header included). */
function cdxRows(rows: Array<[string, string]>): string {
  return JSON.stringify([['timestamp', 'length'], ...rows]);
}

/**
 * CDX body with one capture per month from `first` to `last` (14-digit timestamps),
 * all 5000 bytes, so the whole range is one life and ends on `last`.
 */
function cdxBody(first: string, last: string): string {
  const rows: Array<[string, string]> = [];
  let y = Number(first.slice(0, 4));
  let m = Number(first.slice(4, 6));
  const ly = Number(last.slice(0, 4));
  const lm = Number(last.slice(4, 6));
  while (y < ly || (y === ly && m < lm)) {
    rows.push([`${y}${String(m).padStart(2, '0')}15000000`, '5000']);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  rows[0] = [first, '5000'];
  if (first === last) return cdxRows([[first, '5000']]);
  rows.push([last, '5000']);
  return cdxRows(rows);
}

/** Build a CDX JSON response body with no data rows (not archived). */
function cdxEmptyBody(): string {
  return JSON.stringify([['timestamp', 'length']]);
}

// ---------------------------------------------------------------------------
// Fetch mock factory
// ---------------------------------------------------------------------------

/** Create a minimal Response-like object. */
function makeResponse(opts: {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}): Response {
  const { status = 200, body = '', headers = {} } = opts;
  const responseHeaders = new Headers(headers);
  const response = new Response(body, { status, headers: responseHeaders });
  return response;
}

// ---------------------------------------------------------------------------
// Setup / teardown: clear the in-memory cache between tests
// ---------------------------------------------------------------------------

// The wayback module uses a module-level `memCache` Map.
// We clear it by importing and reaching in — but it's private.
// The simplest approach is to use unique URLs per test so there is no
// cross-test cache pollution.

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. CDX success — getEpitaph returns first and last ISO dates
// ---------------------------------------------------------------------------

describe('getEpitaph — CDX success', () => {
  it('returns first and last ISO dates from CDX timestamps', async () => {
    // One CDX call per URL.
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('/cdx/')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20090312150000', '20231025083000') }));
      }
      return Promise.resolve(makeResponse({ status: 404, body: '' }));
    });

    const client = createWaybackClient();
    const result = await epitaphOf(client, 'https://example.com/cdx-success-1');

    if (result === 'unavailable' || result === 'none') throw new Error('expected epitaph');
    expect(result.first).toBe('2009-03-12');
    expect(result.last).toBe('2023-10-25');
  });

  it('extracts year, month, and day correctly from a 14-digit timestamp', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('/cdx/')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20170315120000', '20220801000001') }));
      }
      return Promise.resolve(makeResponse({ status: 404 }));
    });

    const client = createWaybackClient();
    const result = await epitaphOf(client, 'https://example.com/cdx-success-2');

    if (result === 'unavailable' || result === 'none') throw new Error('expected epitaph');
    expect(result.first).toBe('2017-03-15');
    expect(result.last).toBe('2022-08-01');
  });
});

// ---------------------------------------------------------------------------
// 2. Resurrection URL — format is web/{timestamp}/{url}, no id_
// ---------------------------------------------------------------------------

describe('getResurrection — URL format', () => {
  it('builds the resurrection URL with the last timestamp and no id_ segment', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('/cdx/')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20100101000000', '20231101120000') }));
      }
      return Promise.resolve(makeResponse({ status: 404 }));
    });

    const client = createWaybackClient();
    const resurrection = await resurrectionOf(client, 
      'https://example.com/resurrection-test',
    );

    expect(resurrection).toBeDefined();
    expect(resurrection).toBe(
      'https://web.archive.org/web/20231101120000/https://example.com/resurrection-test',
    );
    // Must NOT contain the id_ segment used only for raw snapshots
    expect(resurrection).not.toContain('id_');
  });

  it('uses the chosen last capture, not the first', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('/cdx/')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20050605000000', '20240315090000') }));
      }
      return Promise.resolve(makeResponse({ status: 404 }));
    });

    const client = createWaybackClient();
    const resurrection = await resurrectionOf(client, 
      'https://example.com/resurrection-last-ts',
    );

    // Should be the last (2024), not the first (2005)
    expect(resurrection).toContain('20240315090000');
    expect(resurrection).not.toContain('20050605000000');
  });

  it('returns none when the archive has no capture', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeResponse({ body: cdxEmptyBody() })),
    );

    const client = createWaybackClient();
    const resurrection = await resurrectionOf(client, 
      'https://example.com/no-snapshot',
    );

    expect(resurrection).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Snapshot text — fetches via id_ URL and strips HTML tags
// ---------------------------------------------------------------------------

describe('getSnapshotText — HTML stripping', () => {
  it('fetches the raw snapshot via the id_ URL and returns stripped text', async () => {
    const html = '<html><body><p>Hello, <strong>world</strong>!</p></body></html>';

    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('/cdx/')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20200101000000', '20200601120000') }));
      }
      // Raw snapshot fetch: must use id_ URL
      if (url.includes('id_/')) {
        return Promise.resolve(makeResponse({ body: html }));
      }
      return Promise.resolve(makeResponse({ status: 404 }));
    });

    const client = createWaybackClient();
    const text = await client.getSnapshotText(
      'https://example.com/snapshot-text',
    );

    expect(text.status).toBe('text');
    const body = text.status === 'text' ? text.text : '';
    expect(body).toContain('Hello');
    expect(body).toContain('world');
    // HTML tags must be stripped
    expect(body).not.toContain('<html>');
    expect(body).not.toContain('<strong>');
  });

  it('uses the id_ URL pattern for the raw snapshot fetch', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('/cdx/')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20210301000000', '20210301000000') }));
      }
      if (url.includes('id_/')) {
        return Promise.resolve(makeResponse({ body: '<p>Snapshot content here</p>' }));
      }
      return Promise.resolve(makeResponse({ status: 404 }));
    });

    const targetUrl = 'https://example.com/id-url-check';
    const client = createWaybackClient();
    await client.getSnapshotText(targetUrl);

    // Verify that at least one call was made with the id_ pattern
    const idFetchCall = fetchSpy.mock.calls.find((args) => {
      const url = args[0] as string;
      return url.includes('id_/') && url.includes(targetUrl);
    });
    expect(idFetchCall).toBeDefined();
  });

  it('returns none when the archive has no capture', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeResponse({ body: cdxEmptyBody() })),
    );

    const client = createWaybackClient();
    const text = await client.getSnapshotText(
      'https://example.com/snapshot-no-archive',
    );

    expect(text).toEqual({ status: 'none' });
  });

  it('returns unavailable when the id_ fetch fails, and does not cache it', async () => {
    let idCalls = 0;
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('/cdx/')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20190101000000', '20190101000000') }));
      }
      if (url.includes('id_/')) {
        idCalls += 1;
        if (idCalls === 1) return Promise.resolve(makeResponse({ status: 503 }));
        return Promise.resolve(makeResponse({ body: '<p>Recovered page</p>' }));
      }
      return Promise.resolve(makeResponse({ status: 404 }));
    });
    const client = createWaybackClient();
    const url = 'https://example.com/snapshot-id-fails';
    expect(await client.getSnapshotText(url)).toEqual({ status: 'unavailable' });
    const second = await client.getSnapshotText(url);
    expect(second.status).toBe('text');
    expect(idCalls).toBe(2);
  });

  it('returns unavailable when the CDX lookup fails', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new Error('boom')));
    const client = createWaybackClient();
    expect(await client.getSnapshotText('https://example.com/snapshot-cdx-fails')).toEqual({
      status: 'unavailable',
    });
  });

  it('strips script and style tags from snapshot HTML', async () => {
    const html =
      '<html><head><style>body{color:red}</style></head>' +
      '<body><script>alert("x")</script><p>Visible text here</p></body></html>';

    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('/cdx/')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20180101000000', '20180101000000') }));
      }
      if (url.includes('id_/')) {
        return Promise.resolve(makeResponse({ body: html }));
      }
      return Promise.resolve(makeResponse({ status: 404 }));
    });

    const client = createWaybackClient();
    const text = await client.getSnapshotText(
      'https://example.com/snapshot-script-style',
    );

    const body = text.status === 'text' ? text.text : '';
    expect(body).toContain('Visible text here');
    expect(body).not.toContain('body{color:red}');
    expect(body).not.toContain('alert');
  });
});

// ---------------------------------------------------------------------------
// 4. 429 back-off — waits Retry-After and retries once
// ---------------------------------------------------------------------------

describe('429 back-off', () => {
  it('retries the single CDX call once after a 429 and returns the epitaph', async () => {
    vi.useFakeTimers();
    let cdxCalls = 0;
    fetchSpy.mockImplementation((url: string) => {
      if (!url.includes('/cdx/')) return Promise.resolve(makeResponse({ status: 404 }));
      cdxCalls += 1;
      if (cdxCalls === 1) {
        return Promise.resolve(makeResponse({ status: 429, headers: { 'Retry-After': '1' } }));
      }
      return Promise.resolve(makeResponse({ body: cdxBody('20150101000000', '20200101000000') }));
    });

    const promise = epitaphOf(createWaybackClient(), 'https://example.com/retry-after-test');
    await vi.runAllTimersAsync();

    expect(await promise).toEqual({ first: '2015-01-01', last: '2020-01-01' });
    expect(cdxCalls).toBe(2);
    vi.useRealTimers();
  });

  it('429 then success: epitaph and resurrection come from the same timestamp set', async () => {
    vi.useFakeTimers();
    let cdxCalls = 0;
    fetchSpy.mockImplementation((url: string) => {
      if (!url.includes('/cdx/')) return Promise.resolve(makeResponse({ status: 404 }));
      cdxCalls += 1;
      if (cdxCalls === 1) {
        return Promise.resolve(makeResponse({ status: 429, headers: { 'Retry-After': '1' } }));
      }
      return Promise.resolve(makeResponse({ body: cdxBody('20150101000000', '20200101000000') }));
    });
    const u = 'https://example.com/archive-429-both';
    const promise = createWaybackClient().getArchive(u);
    await vi.runAllTimersAsync();
    expect(await promise).toEqual({
      epitaph: { first: '2015-01-01', last: '2020-01-01' },
      resurrection: `https://web.archive.org/web/20200101000000/${u}`,
    });
    expect(cdxCalls).toBe(2);
    vi.useRealTimers();
  });
  it('caps Retry-After at 10 seconds regardless of header value', async () => {
    vi.useFakeTimers();
    let cdxCalls = 0;
    fetchSpy.mockImplementation((url: string) => {
      if (!url.includes('/cdx/')) return Promise.resolve(makeResponse({ status: 404 }));
      cdxCalls += 1;
      if (cdxCalls === 1) {
        return Promise.resolve(makeResponse({ status: 429, headers: { 'Retry-After': '60' } }));
      }
      return Promise.resolve(makeResponse({ body: cdxBody('20120101000000', '20200601000000') }));
    });

    const promise = epitaphOf(createWaybackClient(), 'https://example.com/retry-after-cap-test');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await promise).toEqual({ first: '2012-01-01', last: '2020-06-01' });
    vi.useRealTimers();
  });

  it("returns 'unavailable' after a second 429", async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeResponse({ status: 429, headers: { 'Retry-After': '1' } })),
    );
    const promise = epitaphOf(createWaybackClient(), 'https://example.com/double-429');
    await vi.runAllTimersAsync();
    expect(await promise).toBe('unavailable');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
// ---------------------------------------------------------------------------
// 5. CDX unreachable / error → 'unavailable'
// ---------------------------------------------------------------------------

describe('getEpitaph — CDX unreachable or erroring', () => {
  it("returns 'unavailable' when fetch throws a network error", async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    const client = createWaybackClient();
    const result = await epitaphOf(client, 
      'https://example.com/network-error',
    );

    expect(result).toBe('unavailable');
  });

  it("returns 'unavailable' when CDX returns HTTP 500", async () => {
    fetchSpy.mockResolvedValue(makeResponse({ status: 500, body: 'Internal Server Error' }));

    const client = createWaybackClient();
    const result = await epitaphOf(client, 
      'https://example.com/cdx-500-error',
    );

    expect(result).toBe('unavailable');
  });

  it("returns 'unavailable' when CDX returns malformed JSON", async () => {
    fetchSpy.mockResolvedValue(makeResponse({ body: 'not json at all' }));

    const client = createWaybackClient();
    const result = await epitaphOf(client, 
      'https://example.com/cdx-bad-json',
    );

    expect(result).toBe('unavailable');
  });

  it("returns 'none' when CDX returns only the header row (never archived)", async () => {
    // An array with only the header row means no snapshots exist.
    fetchSpy.mockImplementation(() => Promise.resolve(makeResponse({ body: cdxEmptyBody() })));

    const client = createWaybackClient();
    const result = await epitaphOf(client, 
      'https://example.com/cdx-empty',
    );

    expect(result).toBe('none');
  });

  it("returns 'none' when CDX returns an empty array", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(makeResponse({ body: '[]' })));
    const result = await epitaphOf(createWaybackClient(), 'https://example.com/cdx-empty-array');
    expect(result).toBe('none');
  });

  it("does not cache 'unavailable': a later call that succeeds returns the epitaph", async () => {
    const u = 'https://example.com/cdx-retry-after-outage';
    fetchSpy.mockImplementation(() => Promise.resolve(makeResponse({ status: 500, body: 'down' })));
    const client = createWaybackClient();
    expect(await epitaphOf(client, u)).toBe('unavailable');

    fetchSpy.mockImplementation((url: string) =>
      Promise.resolve(makeResponse({ body: cdxBody('20100101000000', '20230101000000') })),
    );
    expect(await epitaphOf(client, u)).toEqual({ first: '2010-01-01', last: '2023-01-01' });
  });

  it("returns 'unavailable' when the AbortController timeout fires", async () => {
    // Simulate a timeout: fetch never resolves, but the AbortController will
    // reject with AbortError when the timer fires.
    vi.useFakeTimers();

    fetchSpy.mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise<Response>((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          }
          // Never resolve — simulates a hanging connection
        });
      },
    );

    const client = createWaybackClient();
    const promise = epitaphOf(client, 'https://example.com/timeout-test');

    // Advance past the 10 s TIMEOUT_MS constant
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await promise;

    expect(result).toBe('unavailable');

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 6. One CDX call, longest life, length parsing
// ---------------------------------------------------------------------------

describe('CDX request and life choice', () => {
  it('makes exactly one CDX request per URL for epitaph + resurrection + snapshot', async () => {
    fetchSpy.mockImplementation((url: string) =>
      Promise.resolve(
        makeResponse({
          body: url.includes('/cdx/') ? cdxBody('20100101000000', '20110101000000') : '<p>hi there</p>',
        }),
      ),
    );
    const client = createWaybackClient();
    const u = 'https://example.com/one-cdx-call';
    await epitaphOf(client, u);
    await resurrectionOf(client, u);
    await client.getSnapshotText(u);
    const cdx = fetchSpy.mock.calls.map((c) => c[0] as string).filter((x) => x.includes('/cdx/'));
    expect(cdx).toHaveLength(1);
    expect(cdx[0]).toContain('fl=timestamp,length');
    expect(cdx[0]).toContain('filter=statuscode:200');
    expect(cdx[0]).toContain('collapse=timestamp:6');
    expect(cdx[0]).not.toContain('limit=');
  });

  it('skips a later life and a tiny last capture; the id_ fetch uses the same timestamp', async () => {
    const rows: Array<[string, string]> = [];
    for (let y = 2000; y <= 2004; y++) rows.push([`${y}0601000000`, '5000']);
    rows.push(['20050601000000', '900']); // parked page, far below half the median
    rows.push(['20230101000000', '5000']); // new life after a long gap
    fetchSpy.mockImplementation((url: string) =>
      Promise.resolve(makeResponse({ body: url.includes('/cdx/') ? cdxRows(rows) : '<p>old page</p>' })),
    );
    const client = createWaybackClient();
    const u = 'https://example.com/life-choice';
    expect(await epitaphOf(client, u)).toEqual({ first: '2000-06-01', last: '2004-06-01' });
    expect(await resurrectionOf(client, u)).toBe(`https://web.archive.org/web/20040601000000/${u}`);
    await client.getSnapshotText(u);
    const raw = fetchSpy.mock.calls.map((c) => c[0] as string).find((x) => x.includes('id_/'));
    expect(raw).toBe(`https://web.archive.org/web/20040601000000id_/${u}`);
  });

  it('treats "-" and non-numeric lengths as unknown', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        makeResponse({
          body: cdxRows([
            ['20100101000000', '-'],
            ['20100201000000', 'abc'],
            ['20100301000000', '-'],
          ]),
        }),
      ),
    );
    const u = 'https://example.com/unknown-lengths';
    expect(await resurrectionOf(createWaybackClient(), u)).toBe(
      `https://web.archive.org/web/20100301000000/${u}`,
    );
  });
});
// ---------------------------------------------------------------------------
// 7. Bodies: 512 KB cap and unread bodies released (task 15.8)
// ---------------------------------------------------------------------------

describe('Wayback bodies', () => {
  function tracked(status: number, chunk: Uint8Array, chunks: number, headers: Record<string, string> = {}) {
    const state = { cancelled: false, pulls: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        state.pulls += 1;
        if (state.pulls > chunks) c.close();
        else c.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { response: new Response(body, { status, headers }), state };
  }

  it('caps the id_ snapshot body at 512 KB, cancels the stream and uses the truncated text', async () => {
    const piece = new TextEncoder().encode('<p>' + 'word '.repeat(13_000) + '</p>'); // about 65 KB
    const snap = tracked(200, piece, 100); // about 6.5 MB offered
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('/cdx/')) return Promise.resolve(makeResponse({ body: cdxBody('20200101000000', '20200101000000') }));
      return Promise.resolve(snap.response);
    });
    const res = await createWaybackClient().getSnapshotText('https://example.com/huge-snapshot');
    expect(res.status).toBe('text');
    expect(snap.state.cancelled).toBe(true);
    expect(snap.state.pulls).toBeLessThan(20);
  });

  it('cancels the body of 429 and non-2xx answers', async () => {
    vi.useFakeTimers();
    const bodies: Array<ReturnType<typeof tracked>> = [];
    fetchSpy.mockImplementation(() => {
      const b = tracked(bodies.length === 0 ? 429 : 503, new Uint8Array(10).fill(65), 5, { 'Retry-After': '1' });
      bodies.push(b);
      return Promise.resolve(b.response);
    });
    const promise = epitaphOf(createWaybackClient(), 'https://example.com/cancel-unread');
    await vi.runAllTimersAsync();
    expect(await promise).toBe('unavailable');
    expect(bodies).toHaveLength(2);
    expect(bodies.every(b => b.state.cancelled)).toBe(true);
    vi.useRealTimers();
  });
});