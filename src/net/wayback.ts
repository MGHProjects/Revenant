/**
 * Wayback Machine client — implements the `Wayback` interface from core/types.ts.
 *
 * APIs used:
 *   CDX (one call per URL): one 200 capture per month with its length, oldest first.
 *     core/lives.ts picks the longest continuous life and the capture to resurrect.
 *   Snapshot text (no toolbar): https://web.archive.org/web/{timestamp}id_/{url}
 *   Resurrection URL (no id_): https://web.archive.org/web/{timestamp}/{url}
 *
 * Caching: 24-hour in-memory Map keyed by URL. 'unavailable' is never cached; 'none' is.
 *          The Workers Cache API is deliberately not used: its match/put calls count toward the
 *          free plan's 50 subrequests per request (see PER_URL_WORST_CASE in judge-link.ts).
 *
 * Bodies: read through readCapped (512 KB, stream cancelled at the cap, truncated body used as
 *         complete). Bodies of 429 and other non-2xx answers are cancelled unread.
 * Queue: every request (CDX, id_ body, availability API) goes through one ArchiveQueue (see
 *        archive-queue.ts): one at a time, a minimum gap between starts, Retry-After honoured.
 * 429 back-off: Retry-After (capped at 10 s) holds back the whole queue; the request is retried once.
 * Timeout: 10 s per request from the moment it starts (queue waiting excluded), body read included;
 *          on failure returns 'unavailable'.
 * An empty CDX answer (archive reachable, no 200 capture) returns 'none'.
 */

import { chooseLife } from '../core/lives.js';
import { visibleText } from '../core/visible-text.js';
import { createArchiveQueue, parseRetryAfter } from './archive-queue.js';
import type { ArchiveQueue } from './archive-queue.js';
import { decodeUtf8, discardBody, readCapped } from './read-capped.js';
import { USER_AGENT } from './user-agent.js';
import type { ArchiveAnswer, Capture, ChosenLife, ClosestSnapshot, EpitaphResult, SnapshotResult, Wayback } from '../core/types.js';

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// One capture per month (collapse=timestamp:6), oldest first.
const CDX_BASE =
  'https://web.archive.org/cdx/search/cdx?output=json&fl=timestamp,length&filter=statuscode:200&collapse=timestamp:6';
const WAYBACK_BASE = 'https://web.archive.org/web';
const TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 10_000;
const TTL_MS = 86_400_000 as const; // 24 h

// ---------------------------------------------------------------------------
// In-memory cache (every environment; free of subrequests)
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

interface WaybackResponse {
  ok: boolean;
  status: number;
  text: string;
  retryAfterMs?: number;
}

/**
 * One request through the archive queue. The 10 s timeout starts when the request starts (not
 * when it was queued) and covers the body read. A 429 or 503 with Retry-After holds back the next
 * request for every caller of the queue.
 */
async function waybackFetch(url: string, queue: ArchiveQueue): Promise<WaybackResponse | undefined> {
  try {
    return await queue.run(async signal => {
      try {
        const response = await fetch(url, {
          signal,
          headers: { 'User-Agent': USER_AGENT },
        });

        const header = parseRetryAfter(response.headers.get('Retry-After'), queue.clock.now());
        if (response.status === 429 || response.status === 503) {
          // Both slow the whole queue down when the archive says how long.
          if (header !== undefined) queue.penalize(header);
        }

        if (response.status === 429) {
          await discardBody(response);
          // 1 s default when the header is absent.
          const retryAfterMs = header ?? 1000;
          if (header === undefined) queue.penalize(retryAfterMs);
          return { ok: false, status: 429, text: '', retryAfterMs };
        }

        // The body of a non-2xx answer is never used: release the connection.
        if (!response.ok) {
          await discardBody(response);
          return { ok: false, status: response.status, text: '' };
        }

        // Capped at 512 KB; a longer body is cut and used as if complete.
        const text = decodeUtf8(await readCapped(response));
        return { ok: true, status: response.status, text };
      } catch {
        return undefined; // network error or timeout
      }
    }, { timeoutMs: TIMEOUT_MS });
  } catch {
    return undefined; // the queue released a request that outlived its timeout
  }
}

/**
 * Fetch a Wayback URL through the queue with one retry after a 429. The retry is a new queue
 * entry, so it starts only after the Retry-After the first answer set.
 * Returns the response text on success, undefined on timeout, error or a second failure.
 */
async function waybackFetchWithRetry(url: string, queue: ArchiveQueue): Promise<string | undefined> {
  const first = await waybackFetch(url, queue);

  if (first === undefined) return undefined; // timeout / network error

  if (first.status === 429) {
    const second = await waybackFetch(url, queue);
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
 * Fetch the monthly-collapsed CDX list for a URL and pick the longest life (see core/lives.ts).
 * 'none' = archive answered with no capture; 'unavailable' = could not be reached or bad reply.
 */
async function fetchLife(targetUrl: string, queue: ArchiveQueue): Promise<ChosenLife | 'none' | 'unavailable'> {
  const cdxUrl = `${CDX_BASE}&url=${encodeURIComponent(targetUrl)}`;
  const text = await waybackFetchWithRetry(cdxUrl, queue);
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

  // rows[0] is the header row; find the columns by name.
  const header = rows[0] as unknown;
  if (!Array.isArray(header)) return 'unavailable';
  const tsCol = header.indexOf('timestamp');
  const lenCol = header.indexOf('length');
  if (tsCol < 0) return 'unavailable';

  const captures: Capture[] = [];
  for (const row of rows.slice(1) as unknown[]) {
    if (!Array.isArray(row)) continue;
    const ts: unknown = row[tsCol];
    if (typeof ts !== 'string' || !/^\d{14}$/.test(ts)) continue;
    const raw: unknown = lenCol >= 0 ? row[lenCol] : undefined;
    const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : undefined;
    captures.push({ timestamp: ts, length: n });
  }

  return chooseLife(captures) ?? 'unavailable';
}
// ---------------------------------------------------------------------------
// Cache lookup / population
// ---------------------------------------------------------------------------

/** Load a live cache entry from memory, or undefined. */
function loadEntry(url: string): WaybackCacheEntry | undefined {
  return getCached(url);
}

/** Populate a fresh cache entry for a URL by querying CDX. */
async function buildEntry(url: string, queue: ArchiveQueue): Promise<WaybackCacheEntry> {
  const life = await fetchLife(url, queue);

  const entry: WaybackCacheEntry = {
    cachedAt: Date.now(),
    ttlMs: TTL_MS,
  };

  if (life === 'unavailable') {
    entry.epitaph = 'unavailable';
  } else if (life === 'none') {
    entry.epitaph = 'none';
  } else {
    entry.epitaph = {
      first: timestampToDate(life.first),
      last: timestampToDate(life.last),
      copy: timestampToDate(life.copy),
    };
    // Resurrection URL: the chosen capture, no id_ (shows Wayback toolbar)
    entry.resurrection = `${WAYBACK_BASE}/${life.copy}/${url}`;
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

async function getEntry(url: string, queue: ArchiveQueue): Promise<WaybackCacheEntry> {
  const key = cacheKey(url);
  const existing = loadEntry(key);
  if (existing) return existing;

  const entry = await buildEntry(url, queue);

  // 'unavailable' is transient: never cached, so a retry asks the archive again.
  if (entry.epitaph === 'unavailable') return entry;
  memCache.set(key, entry);

  return entry;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface WaybackClientOptions {
  /**
   * The queue every request goes through. Share it with the fetcher (createFetcher) so links to
   * web.archive.org wait in the same line. Without one the client gets its own queue with no gap
   * (still one request at a time).
   */
  queue?: ArchiveQueue;
}

/**
 * Create a Wayback Machine client. Calls go straight to the platform `fetch`,
 * not through the core `Fetcher` abstraction, but always through the archive queue.
 */
export function createWaybackClient(options: WaybackClientOptions = {}): Wayback {
  const queue = options.queue ?? createArchiveQueue({ minGapMs: 0 });
  /** One CDX request (or one cache hit) gives the epitaph and the resurrection together. */
  async function archiveOf(url: string): Promise<ArchiveAnswer> {
    const entry = await getEntry(url, queue);
    const epitaph = entry.epitaph ?? 'unavailable';
    // Both or neither: a resurrection only travels with a dated epitaph.
    if (typeof epitaph === 'object' && entry.resurrection !== undefined) {
      return { epitaph, resurrection: entry.resurrection };
    }
    return { epitaph: typeof epitaph === 'object' ? 'unavailable' : epitaph };
  }

  return {
    async getClosestSnapshot(url: string, date?: string): Promise<ClosestSnapshot> {
      const ts = date ? date.replace(/-/g, '') : '';
      const api =
        `https://archive.org/wayback/available?url=${encodeURIComponent(url)}` +
        (ts ? `&timestamp=${ts}` : '');
      const text = await waybackFetchWithRetry(api, queue);
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

    getArchive: archiveOf,

    async getSnapshotText(url: string, archive?: ArchiveAnswer): Promise<SnapshotResult> {
      // Reuse the answer the caller already holds; otherwise ask (cached or one CDX request).
      const known = archive ?? (await archiveOf(url));
      const key = cacheKey(url);
      const cached = loadEntry(key);

      // Return from cache if already fetched (only 'text' and 'none' are ever stored)
      if (cached?.snapshot) return cached.snapshot;

      // CDX lookup failed: the archive could not be reached.
      if (known.epitaph === 'unavailable') return { status: 'unavailable' };

      // The archive answered with no 200 capture.
      if (!known.resurrection) return { status: 'none' };

      // Extract timestamp from resurrection URL:
      // https://web.archive.org/web/{timestamp}/{url}
      const match = known.resurrection.match(
        /^https:\/\/web\.archive\.org\/web\/(\d{14})\//,
      );
      if (!match) return { status: 'unavailable' };

      const timestamp = match[1];
      // Raw snapshot (id_ suppresses Wayback toolbar)
      const snapshotUrl = `${WAYBACK_BASE}/${timestamp}id_/${url}`;

      const html = await waybackFetchWithRetry(snapshotUrl, queue);

      // A failed body fetch is transient: report it, but do not cache it.
      if (html === undefined) return { status: 'unavailable' };

      const text = visibleText(html);
      // An empty capture gives nothing to compare against.
      const result: SnapshotResult = text === '' ? { status: 'none' } : { status: 'text', text };

      // Store only on an entry that holds a real CDX answer; 'unavailable' is never cached.
      const stored = loadEntry(key);
      if (stored) {
        stored.snapshot = result;
        setCached(key, stored);
      }

      return result;
    },
  };
}
