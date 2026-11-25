/**
 * Revenant — Cloudflare Worker entry point.
 *
 * Routes:
 *   POST /api/scan    — accept { urls: string[] } (max 3), return { judgements: Judgement[] }
 *   POST /api/resolve — accept { input: string, kind: 'url' | 'repo' }, return { source, kind }
 *
 * Free-plan constraints (50 subrequests, 10 ms CPU per request): max 3 URLs per /api/scan call,
 * 64 KB text cap per side. Worst case is 16 subrequests per URL (PER_URL_WORST_CASE), 3 x 16 = 48,
 * with no Cache API calls (they count toward the 50). The table is in src/net/judge-link.ts.
 *
 * Requirements: 6.1, 5
 */

import { Hono } from 'hono';
import { fetcher } from '../net/fetcher.js';
import { resolveRepoReadme } from '../net/github-readme.js';
import { defaultSleep, judgeLink } from '../net/judge-link.js';
import { MAX_BODY_BYTES as FETCH_MAX_BYTES } from '../net/read-capped.js';
import { createWaybackClient } from '../net/wayback.js';
import type { Judgement } from '../core/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_URLS = 3;
const MAX_BODY_BYTES = 1_048_576; // 1 MB
const TIMEOUT_MS = 8_000;
const RESOLVE_MAX_BYTES = FETCH_MAX_BYTES; // 512 KB
const SNAPSHOT_TEXT_CAP = 65_536; // 64 KB
// shortcut: fixed 64 KB cap, raise it if the Worker is moved to the paid plan.

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

// GITHUB_TOKEN is an optional Worker secret; it is passed to the GitHub API only.
const app = new Hono<{ Bindings: { GITHUB_TOKEN?: string } }>();

// POST /api/scan
app.post('/api/scan', async (c) => {
  try {
    // ---- Body size check ----
    const contentLength = c.req.header('content-length');
    if (contentLength !== undefined && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
      return c.json({ error: 'Request body too large' }, 413);
    }

    // Read raw body and check actual byte length
    const rawBody = await c.req.raw.arrayBuffer();
    if (rawBody.byteLength > MAX_BODY_BYTES) {
      return c.json({ error: 'Request body too large' }, 413);
    }

    // ---- Parse JSON ----
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    // ---- Validate structure ----
    if (
      typeof body !== 'object' ||
      body === null ||
      !Array.isArray((body as Record<string, unknown>)['urls'])
    ) {
      return c.json({ error: 'Body must be { urls: string[] }' }, 400);
    }

    const urls: unknown[] = (body as Record<string, unknown>)['urls'] as unknown[];

    if (urls.length > MAX_URLS) {
      return c.json({ error: `At most ${MAX_URLS} URLs per request` }, 400);
    }

    for (const u of urls) {
      if (typeof u !== 'string') {
        return c.json({ error: 'Each URL must be a string' }, 400);
      }
    }

    const validUrls = urls as string[];

    // ---- Judge up to 3 URLs concurrently (guard included), order preserved ----
    const deps = { fetcher, wayback: createWaybackClient(), sleep: defaultSleep };
    const judgements: Judgement[] = await Promise.all(
      validUrls.map(url => judgeLink({ url, spans: [] }, deps, { textCap: SNAPSHOT_TEXT_CAP })),
    );
    return c.json({ judgements });
  } catch {
    // Never expose stack traces
    return c.json({ error: 'Internal error' }, 500);
  }
});

// POST /api/resolve
// Requirements: 1.3, 1.4
app.post('/api/resolve', async (c) => {
  try {
    // ---- Parse JSON body ----
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (
      typeof body !== 'object' ||
      body === null
    ) {
      return c.json({ error: 'Body must be { input: string, kind: "url" | "repo" }' }, 400);
    }

    const { input, kind } = body as Record<string, unknown>;

    if (typeof input !== 'string' || (kind !== 'url' && kind !== 'repo')) {
      return c.json({ error: 'Body must be { input: string, kind: "url" | "repo" }' }, 400);
    }

    // ---- Handle kind === 'url' ----
    if (kind === 'url') {
      // The shared fetcher guards the URL and every redirect hop, caps the body at 512 KB
      // and keeps the 8 s timeout running while the body is read.
      const probe = await fetcher(input, { timeoutMs: TIMEOUT_MS, maxBytes: RESOLVE_MAX_BYTES });

      if (probe.outcome === 'timeout') {
        return c.json({ error: 'Could not load that address: no answer within 8 s.' }, 422);
      }
      if (probe.outcome === 'network-error') {
        if (probe.blocked) {
          return c.json({ error: `That address is not allowed: ${probe.text ?? 'blocked'}` }, 422);
        }
        if (probe.dnsFailure) {
          return c.json({ error: 'Could not load that address: the domain no longer resolves.' }, 422);
        }
        return c.json({ error: `Could not load that address: ${probe.text ?? 'network error'}` }, 422);
      }
      const status = probe.status ?? 0;
      if (status < 200 || status >= 300) {
        return c.json({ error: `Could not load that address: it answered ${status}.` }, 422);
      }

      // Kind is detected from the Content-Type header (fetcher exposes it) or a body sniff.
      const responseText = probe.text ?? '';
      const contentTypeHeader = probe.contentType ?? '';
      const trimmed = responseText.trimStart();
      const isHtml =
        trimmed.startsWith('<!DOCTYPE html') ||
        trimmed.startsWith('<!doctype html') ||
        trimmed.startsWith('<html') ||
        contentTypeHeader.includes('text/html');

      return c.json({ source: responseText, kind: isHtml ? 'html' : 'markdown' });
    }

    // ---- Handle kind === 'repo' ----
    if (kind === 'repo') {
      const result = await resolveRepoReadme(input, undefined, c.env?.GITHUB_TOKEN);
      if (result.ok) {
        return c.json({ source: result.source, kind: result.kind });
      }
      const status = { 'not-found': 404, 'rate-limited': 429, invalid: 400, unavailable: 502 } as const;
      return c.json({ error: result.message }, status[result.code]);
    }
  } catch {
    // Never expose stack traces
    return c.json({ error: 'Internal error' }, 500);
  }
});

export default app;
