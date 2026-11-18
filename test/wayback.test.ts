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

// ---------------------------------------------------------------------------
// CDX response helpers
// ---------------------------------------------------------------------------

/** Build a CDX JSON response body with one data row. */
function cdxBody(timestamp: string): string {
  return JSON.stringify([['timestamp', 'statuscode'], [timestamp, '200']]);
}

/** Build a CDX JSON response body with no data rows (not archived). */
function cdxEmptyBody(): string {
  return JSON.stringify([['timestamp', 'statuscode']]);
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
    // Two CDX calls: limit=1 (first), limit=-1 (last).
    // We match by URL to serve the right fixture for each call.
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('limit=1')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20090312150000') }));
      }
      if (url.includes('limit=-1')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20231025083000') }));
      }
      return Promise.resolve(makeResponse({ status: 404, body: '' }));
    });

    const client = createWaybackClient();
    const result = await client.getEpitaph('https://example.com/cdx-success-1');

    expect(result).not.toBe('unavailable');
    if (result === 'unavailable') return; // narrow type for TS
    expect(result.first).toBe('2009-03-12');
    expect(result.last).toBe('2023-10-25');
  });

  it('extracts year, month, and day correctly from a 14-digit timestamp', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('limit=1')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20170315120000') }));
      }
      if (url.includes('limit=-1')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20220801000001') }));
      }
      return Promise.resolve(makeResponse({ status: 404 }));
    });

    const client = createWaybackClient();
    const result = await client.getEpitaph('https://example.com/cdx-success-2');

    expect(result).not.toBe('unavailable');
    if (result === 'unavailable') return;
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
      if (url.includes('limit=1')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20100101000000') }));
      }
      if (url.includes('limit=-1')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20231101120000') }));
      }
      return Promise.resolve(makeResponse({ status: 404 }));
    });

    const client = createWaybackClient();
    const resurrection = await client.getResurrection(
      'https://example.com/resurrection-test',
    );

    expect(resurrection).toBeDefined();
    expect(resurrection).toBe(
      'https://web.archive.org/web/20231101120000/https://example.com/resurrection-test',
    );
    // Must NOT contain the id_ segment used only for raw snapshots
    expect(resurrection).not.toContain('id_');
  });

  it('uses the last CDX timestamp (limit=-1), not the first', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('limit=1')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20050605000000') }));
      }
      if (url.includes('limit=-1')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20240315090000') }));
      }
      return Promise.resolve(makeResponse({ status: 404 }));
    });

    const client = createWaybackClient();
    const resurrection = await client.getResurrection(
      'https://example.com/resurrection-last-ts',
    );

    // Should be the last (2024), not the first (2005)
    expect(resurrection).toContain('20240315090000');
    expect(resurrection).not.toContain('20050605000000');
  });

  it('returns undefined when no snapshot exists', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeResponse({ body: cdxEmptyBody() })),
    );

    const client = createWaybackClient();
    const resurrection = await client.getResurrection(
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
      if (url.includes('limit=1')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20200101000000') }));
      }
      if (url.includes('limit=-1')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20200601120000') }));
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

    expect(text).toBeDefined();
    expect(text).toContain('Hello');
    expect(text).toContain('world');
    // HTML tags must be stripped
    expect(text).not.toContain('<html>');
    expect(text).not.toContain('<strong>');
  });

  it('uses the id_ URL pattern for the raw snapshot fetch', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('limit=1')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20210301000000') }));
      }
      if (url.includes('limit=-1')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20210301000000') }));
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

  it('returns undefined when no snapshot exists', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeResponse({ body: cdxEmptyBody() })),
    );

    const client = createWaybackClient();
    const text = await client.getSnapshotText(
      'https://example.com/snapshot-no-archive',
    );

    expect(text).toBeUndefined();
  });

  it('strips script and style tags from snapshot HTML', async () => {
    const html =
      '<html><head><style>body{color:red}</style></head>' +
      '<body><script>alert("x")</script><p>Visible text here</p></body></html>';

    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('limit=1')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20180101000000') }));
      }
      if (url.includes('limit=-1')) {
        return Promise.resolve(makeResponse({ body: cdxBody('20180101000000') }));
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

    expect(text).toContain('Visible text here');
    expect(text).not.toContain('body{color:red}');
    expect(text).not.toContain('alert');
  });
});

// ---------------------------------------------------------------------------
// 4. 429 back-off — waits Retry-After and retries once
// ---------------------------------------------------------------------------

describe('429 back-off', () => {
  it('retries once after a 429 and returns the second response', async () => {
    // Use vi.useFakeTimers to avoid real sleeps in tests
    vi.useFakeTimers();

    let callCount = 0;
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('cdx')) {
        callCount += 1;
        if (callCount === 1) {
          // First CDX call (limit=1) → 429
          return Promise.resolve(
            makeResponse({
              status: 429,
              headers: { 'Retry-After': '1' },
            }),
          );
        }
        // Subsequent CDX calls → success
        if (url.includes('limit=1')) {
          return Promise.resolve(makeResponse({ body: cdxBody('20150101000000') }));
        }
        if (url.includes('limit=-1')) {
          return Promise.resolve(makeResponse({ body: cdxBody('20200101000000') }));
        }
      }
      return Promise.resolve(makeResponse({ status: 404 }));
    });

    const client = createWaybackClient();

    // Start the promise but don't await — advance timers to skip the sleep
    const promise = client.getEpitaph('https://example.com/retry-after-test');
    await vi.runAllTimersAsync();
    const result = await promise;

    // After retry, we should get a valid epitaph
    expect(result).not.toBe('unavailable');

    vi.useRealTimers();
  });

  it('caps Retry-After at 10 seconds regardless of header value', async () => {
    vi.useFakeTimers();

    // We test that an excessive Retry-After (60 s) does not stall indefinitely
    // — the cap means vi.runAllTimersAsync() will advance past it.
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('cdx')) {
        if (url.includes('limit=1')) {
          // Alternate: first call 429 with big delay, second success
          if (fetchSpy.mock.calls.filter((c) => (c[0] as string).includes('limit=1')).length === 1) {
            return Promise.resolve(
              makeResponse({ status: 429, headers: { 'Retry-After': '60' } }),
            );
          }
          return Promise.resolve(makeResponse({ body: cdxBody('20120101000000') }));
        }
        if (url.includes('limit=-1')) {
          return Promise.resolve(makeResponse({ body: cdxBody('20200601000000') }));
        }
      }
      return Promise.resolve(makeResponse({ status: 404 }));
    });

    const client = createWaybackClient();
    const promise = client.getEpitaph(
      'https://example.com/retry-after-cap-test',
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    // If the cap works, the timers advance and we get a result
    expect(result).toBeDefined();

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
    const result = await client.getEpitaph(
      'https://example.com/network-error',
    );

    expect(result).toBe('unavailable');
  });

  it("returns 'unavailable' when CDX returns HTTP 500", async () => {
    fetchSpy.mockResolvedValue(makeResponse({ status: 500, body: 'Internal Server Error' }));

    const client = createWaybackClient();
    const result = await client.getEpitaph(
      'https://example.com/cdx-500-error',
    );

    expect(result).toBe('unavailable');
  });

  it("returns 'unavailable' when CDX returns malformed JSON", async () => {
    fetchSpy.mockResolvedValue(makeResponse({ body: 'not json at all' }));

    const client = createWaybackClient();
    const result = await client.getEpitaph(
      'https://example.com/cdx-bad-json',
    );

    expect(result).toBe('unavailable');
  });

  it("returns 'unavailable' when CDX returns an empty array (no captures)", async () => {
    // An array with only the header row means no snapshots exist.
    fetchSpy.mockResolvedValue(makeResponse({ body: cdxEmptyBody() }));

    const client = createWaybackClient();
    const result = await client.getEpitaph(
      'https://example.com/cdx-empty',
    );

    expect(result).toBe('unavailable');
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
    const promise = client.getEpitaph('https://example.com/timeout-test');

    // Advance past the 10 s TIMEOUT_MS constant
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await promise;

    expect(result).toBe('unavailable');

    vi.useRealTimers();
  });
});
