/**
 * Wayback Machine client — implements the `Wayback` interface from core/types.ts.
 *
 * APIs used:
 *   CDX first: ?limit=1  → earliest 200 snapshot
 *   CDX last:  ?limit=-1 → most recent 200 snapshot
 *   Snapshot text (no toolbar): https://web.archive.org/web/{timestamp}id_/{url}
 *   Resurrection URL (no id_): https://web.archive.org/web/{timestamp}/{url}
 *
 * Caching: 24-hour in-memory Map keyed by URL. 'unavailable' is never cached; 'none' is.
 *          Also attempts the platform Cache API (Workers) with a try/catch.
 *
 * 429 back-off: reads Retry-After (capped at 10 s), waits, retries once.
 * Timeout: 10 s on all Wayback requests; on failure returns 'unavailable'.
 * An empty CDX answer (archive reachable, no 200 capture) returns 'none'.
 */

import { visibleText } from '../core/visible-text.js';
import type { ClosestSnapshot, Epitaph, EpitaphResult, SnapshotResult, Wayback } from '../core/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WaybackCacheEntry {
  epitaph?: EpitaphResult;
  resurrection?: string;
  /** Never holds 'unavailable'. */
  snapshot?: SnapshotResult;
  cachedAt: number;
  ttlMs: 86_400_000;
}

// CDX JSON response row: [timestamp, statuscode]
type CdxRow = [string, string];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CDX_BASE =
  'https://web.archive.org/cdx/search/cdx?output=json&fl=timestamp,statuscode&filter=statuscode:200';
const WAYBACK_BASE = 'https://web.archive.org/web';
const USER_AGENT = 'Revenant/1.0';
const TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 10_000;
const TTL_MS = 86_400_000 as const; // 24 h

// ---------------------------------------------------------------------------
// In-memory cache (CLI / MCP / Node environments)
// ---------------------------------------------------------------------------

const memCache = new Map<string, WaybackCacheEntry>();

function getCached(url: string): WaybackCacheEntry | undefined {
  const entry = memCache.get(url);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > entry.ttlMs) {
    memCache.delete(url);
    return undefined;
  }
  return entry;
}

function setCached(url: string, entry: WaybackCacheEntry): void {
  memCache.set(url, entry);
}

// ---------------------------------------------------------------------------
// Worker platform Cache API helpers
// ---------------------------------------------------------------------------

async function platformCacheGet(key: string): Promise<WaybackCacheEntry | undefined> {
  try {
    // `caches` is only defined in the Workers runtime
    const cache = await caches.open('wayback-v1');
    const response = await cache.match(new Request(key));
    if (!response) return undefined;
    return (await response.json()) as WaybackCacheEntry;
  } catch {
    return undefined;
  }
}

async function platformCacheSet(key: string, entry: WaybackCacheEntry): Promise<void> {
  try {
    const cache = await caches.open('wayback-v1');
    const response = new Response(JSON.stringify(entry), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=${Math.floor(TTL_MS / 1000)}`,
      },
    });
    await cache.put(new Request(key), response);
  } catch {
    // Platform cache unavailable — in-memory cache is sufficient
  }
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

/** Convert a CDX timestamp (YYYYMMDDHHmmss) to an ISO date (YYYY-MM-DD). */
function timestampToDate(ts: string): string {
  // ts is 14 digits: YYYYMMDDHHmmss
  const year = ts.slice(0, 4);
  const month = ts.slice(4, 6);
  const day = ts.slice(6, 8);
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Low-level fetch with timeout, retry-after, and 429 back-off
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WaybackResponse {
  ok: boolean;
  status: number;
  text: string;
  retryAfterMs?: number;
}

async function waybackFetch(url: string): Promise<WaybackResponse | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });

    clearTimeout(timer);

    if (response.status === 429) {
      const retryAfterRaw = response.headers.get('Retry-After');
      let retryAfterMs = 1000; // default 1 s if header absent
      if (retryAfterRaw) {
        const seconds = parseFloat(retryAfterRaw);
        if (!isNaN(seconds)) {
          retryAfterMs = Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
        }
      }
      return { ok: false, status: 429, text: '', retryAfterMs };
    }

    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch {
    clearTimeout(timer);
    return undefined; // network error or timeout
  }
}

/**
 * Fetch a Wayback URL with automatic 429 back-off (one retry).
 * Returns the response text on success, undefined on timeout/error,
 * and throws a special symbol on permanent failure after retry.
 */
async function waybackFetchWithRetry(url: string): Promise<string | undefined> {
  const first = await waybackFetch(url);

  if (first === undefined) return undefined; // timeout / network error

  if (first.status === 429) {
    // Wait and retry once
    await sleep(first.retryAfterMs ?? 1000);
    const second = await waybackFetch(url);
    if (second === undefined || !second.ok) return undefined;
    return second.text;
  }

  if (!first.ok) return undefined;
  return first.text;
}

// ---------------------------------------------------------------------------
// CDX query
// ---------------------------------------------------------------------------

/**
 * Fetch a CDX endpoint and return the first data row's timestamp (index 0 is headers).
 * 'none' = archive answered with no capture; 'unavailable' = could not be reached or bad reply.
 */
async function fetchCdxTimestamp(
  targetUrl: string,
  limit: 1 | -1,
): Promise<string | 'none' | 'unavailable'> {
  const cdxUrl = `${CDX_BASE}&url=${encodeURIComponent(targetUrl)}&limit=${limit}`;
  const text = await waybackFetchWithRetry(cdxUrl);
  if (text === undefined) return 'unavailable';

  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    // The CDX server answers an empty result set with an empty body.
    return text.trim() === '' ? 'none' : 'unavailable';
  }

  if (!Array.isArray(rows)) return 'unavailable';
  if (rows.length < 2) return 'none';

  // rows[0] = ["timestamp","statuscode"] header; rows[1..] = data
  const data = rows[1] as CdxRow;
  if (!Array.isArray(data) || typeof data[0] !== 'string') return 'unavailable';

  return data[0]; // timestamp string
}

// ---------------------------------------------------------------------------
// Cache lookup / population
// ---------------------------------------------------------------------------

/** Load cache entry from platform cache or memory, returning undefined if missing. */
async function loadEntry(url: string): Promise<WaybackCacheEntry | undefined> {
  const mem = getCached(url);
  if (mem) return mem;
  const platform = await platformCacheGet(url);
  if (platform && platform.epitaph !== 'unavailable') {
    setCached(url, platform);
    return platform;
  }
  return undefined;
}

/** Populate a fresh cache entry for a URL by querying CDX. */
async function buildEntry(url: string): Promise<WaybackCacheEntry> {
  const [firstTs, lastTs] = await Promise.all([
    fetchCdxTimestamp(url, 1),
    fetchCdxTimestamp(url, -1),
  ]);

  const entry: WaybackCacheEntry = {
    cachedAt: Date.now(),
    ttlMs: TTL_MS,
  };

  if (firstTs === 'unavailable' || lastTs === 'unavailable') {
    entry.epitaph = 'unavailable';
  } else if (firstTs === 'none' || lastTs === 'none') {
    entry.epitaph = 'none';
  } else {
    entry.epitaph = {
      first: timestampToDate(firstTs),
      last: timestampToDate(lastTs),
    };
    // Resurrection URL: last snapshot, no id_ (shows Wayback toolbar)
    entry.resurrection = `${WAYBACK_BASE}/${lastTs}/${url}`;
    // We fetch snapshot text lazily in getSnapshotText, stored separately
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Per-URL cache: keyed by the original URL to avoid collisions
// ---------------------------------------------------------------------------

const URL_PREFIX = 'https://wayback-cache.revenant.internal/';

function cacheKey(url: string): string {
  return `${URL_PREFIX}${encodeURIComponent(url)}`;
}

async function getEntry(url: string): Promise<WaybackCacheEntry> {
  const key = cacheKey(url);
  const existing = await loadEntry(key);
  if (existing) return existing;

  const entry = await buildEntry(url);

  // 'unavailable' is transient: never cached, so a retry asks the archive again.
  if (entry.epitaph === 'unavailable') return entry;
  memCache.set(key, entry);
  await platformCacheSet(key, entry);

  return entry;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a Wayback Machine client.
 *
 * The optional `fetcher` parameter exists for interface consistency with the
 * rest of the net layer but is not used here — Wayback calls are always made
 * directly with the platform `fetch`, since they are made by the client
 * itself, not passed through the core `Fetcher` abstraction.
 */
export function createWaybackClient(_fetcher?: unknown): Wayback {
  return {
    async getClosestSnapshot(url: string, date?: string): Promise<ClosestSnapshot> {
      const ts = date ? date.replace(/-/g, '') : '';
      const api =
        `https://archive.org/wayback/available?url=${encodeURIComponent(url)}` +
        (ts ? `&timestamp=${ts}` : '');
      const text = await waybackFetchWithRetry(api);
      if (text === undefined) return { status: 'unreachable' };
      try {
        const body = JSON.parse(text) as {
          archived_snapshots?: { closest?: { available?: boolean; url?: string; timestamp?: string } };
        };
        const c = body.archived_snapshots?.closest;
        if (!c || !c.available || typeof c.url !== 'string' || typeof c.timestamp !== 'string') {
          return { status: 'none' };
        }
        return {
          status: 'found',
          url: c.url.replace(/^http:\/\//, 'https://'),
          date: timestampToDate(c.timestamp),
        };
      } catch {
        return { status: 'unreachable' };
      }
    },

    async getEpitaph(url: string): Promise<EpitaphResult> {
      const entry = await getEntry(url);
      return entry.epitaph ?? 'unavailable';
    },

    async getResurrection(url: string): Promise<string | undefined> {
      const entry = await getEntry(url);
      return entry.resurrection;
    },

    async getSnapshotText(url: string): Promise<SnapshotResult> {
      const entry = await getEntry(url);

      // Return from cache if already fetched (only 'text' and 'none' are ever stored)
      if (entry.snapshot) return entry.snapshot;

      // CDX lookup failed: the archive could not be reached.
      if (entry.epitaph === 'unavailable') return { status: 'unavailable' };

      // The archive answered with no 200 capture.
      if (!entry.resurrection) return { status: 'none' };

      // Extract timestamp from resurrection URL:
      // https://web.archive.org/web/{timestamp}/{url}
      const match = entry.resurrection.match(
        /^https:\/\/web\.archive\.org\/web\/(\d{14})\//,
      );
      if (!match) return { status: 'unavailable' };

      const timestamp = match[1];
      // Raw snapshot (id_ suppresses Wayback toolbar)
      const snapshotUrl = `${WAYBACK_BASE}/${timestamp}id_/${url}`;

      const html = await waybackFetchWithRetry(snapshotUrl);

      // A failed body fetch is transient: report it, but do not cache it.
      if (html === undefined) return { status: 'unavailable' };

      const text = visibleText(html);
      // An empty capture gives nothing to compare against.
      const result: SnapshotResult = text === '' ? { status: 'none' } : { status: 'text', text };

      entry.snapshot = result;
      const key = cacheKey(url);
      setCached(key, entry);
      await platformCacheSet(key, entry);

      return result;
    },
  };
}
