/**
 * Revenant — Cloudflare Worker entry point.
 *
 * Routes:
 *   POST /api/scan    — accept { urls: string[] } (max 3), return { judgements: Judgement[] }
 *   POST /api/resolve — accept { input: string, kind: 'url' | 'repo' }, return { source, kind }
 *
 * Free-plan constraints (50 subrequests, 10 ms CPU per request):
 *   - max 3 URLs per /api/scan call
 *   - worst case per URL is 16 subrequests (3 URLs = 48): first attempt 6 hops + 1 DoH
 *     query (a 530 whose A query found records), retry 6 hops with no DoH, 3 Wayback calls.
 *     A 530 that used 2 DoH queries is not retried (8, no Wayback); a thrown fetch is 6 + 2 + 3.
 *   - similarity applied to first 64 KB of visible text only
 *   // shortcut: fixed 64 KB cap, raise it if the Worker is moved to the paid plan.
 *
 * Requirements: 6.1, 5
 */

import { Hono } from 'hono';
import { guard } from '../core/guard.js';
import { classify } from '../core/classify.js';
import { similarity } from '../core/similarity.js';
import { visibleText } from '../core/visible-text.js';
import { registrableDomain } from '../core/domain.js';
import { fetcher } from '../net/fetcher.js';
import { shouldRetry } from '../net/retry.js';
import { createWaybackClient } from '../net/wayback.js';
import type { Judgement, Link, SnapshotResult } from '../core/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_URLS = 3;
const MAX_BODY_BYTES = 1_048_576; // 1 MB
const TIMEOUT_MS = 8_000;
const MAX_BYTES = 524_288; // 512 KB
const RETRY_DELAY_MS = 2_000;
const SNAPSHOT_TEXT_CAP = 65_536; // 64 KB
// shortcut: fixed 64 KB cap, raise it if the Worker is moved to the paid plan.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Per-URL scan logic (Worker edition — pool of 3, no meta event)
// ---------------------------------------------------------------------------

async function scanUrl(url: string): Promise<Judgement> {
  const wayback = createWaybackClient();

  // Build a minimal Link for the URL (no source spans in API mode)
  const link: Link = { url, spans: [] };

  // Fetch with standard limits
  let probe = await fetcher(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });

  // 5xx: retry once after 2 s
  // The retry skips DNS confirmation (keeps the per-URL subrequest budget at 16).
  if (shouldRetry(probe)) {
    await sleep(RETRY_DELAY_MS);
    probe = await fetcher(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, skipDns: true });
  }

  // Determine whether we need a snapshot text for the possessed check
  let snapshotText: SnapshotResult | undefined;
  if (
    probe.outcome === 'response' &&
    probe.status !== undefined &&
    probe.status >= 200 &&
    probe.status <= 299 &&
    probe.finalUrl !== undefined
  ) {
    const origDomain = registrableDomain(hostnameOf(url));
    const finalDomain = registrableDomain(hostnameOf(probe.finalUrl));
    if (origDomain !== finalDomain && finalDomain !== '') {
      const rawText = await wayback.getSnapshotText(url);
      // Apply 64 KB cap before similarity computation
      snapshotText =
        rawText.status === 'text'
          ? { status: 'text', text: rawText.text.slice(0, SNAPSHOT_TEXT_CAP) }
          : rawText;
    }
  }

  // Also cap the probe body text before classify feeds it to similarity
  const cappedProbe =
    probe.text !== undefined && probe.text.length > SNAPSHOT_TEXT_CAP
      ? { ...probe, text: visibleText(probe.text).slice(0, SNAPSHOT_TEXT_CAP) }
      : probe.text !== undefined && probe.outcome === 'response' && probe.status !== undefined && probe.status >= 200 && probe.status <= 299
        ? { ...probe, text: visibleText(probe.text).slice(0, SNAPSHOT_TEXT_CAP) }
        : probe;

  const { verdict, reason } = classify(cappedProbe, url, snapshotText);

  const judgement: Judgement = { link, verdict, reason };

  // Enrich with epitaph and resurrection for dead/possessed links
  if (verdict === 'dead' || verdict === 'possessed') {
    judgement.epitaph = await wayback.getEpitaph(url);
    const resurrection = await wayback.getResurrection(url);
    if (resurrection !== undefined) {
      judgement.resurrection = resurrection;
    }
  }

  return judgement;
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

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

    // ---- Guard each URL ----
    const guardedJudgements: Judgement[] = [];
    const passingUrls: string[] = [];

    for (const url of validUrls) {
      const result = guard(url);
      if (!result.ok) {
        guardedJudgements.push({
          link: { url, spans: [] },
          verdict: 'restless',
          reason: `Not checked: ${result.reason}.`,
        });
      } else {
        passingUrls.push(url);
      }
    }

    // ---- Run up to 3 concurrent fetcher calls ----
    const fetchPromises = passingUrls.map(url => scanUrl(url));
    const fetchedJudgements = await Promise.all(fetchPromises);

    // ---- Build result, preserving original order ----
    const judgementsMap = new Map<string, Judgement>();
    for (const j of guardedJudgements) {
      judgementsMap.set(j.link.url, j);
    }
    for (const j of fetchedJudgements) {
      judgementsMap.set(j.link.url, j);
    }

    const judgements: Judgement[] = validUrls.map(url => judgementsMap.get(url)!);

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
      const guardResult = guard(input);
      if (!guardResult.ok) {
        return c.json({ error: guardResult.reason }, 422);
      }

      let response: Response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          response = await fetch(input, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Revenant/1.0' },
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `Failed to fetch: ${message}` }, 422);
      }

      if (!response.ok) {
        return c.json({ error: `Failed to fetch: HTTP ${response.status}` }, 422);
      }

      const responseText = await response.text();
      const contentTypeHeader = response.headers.get('content-type') ?? '';
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
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input)) {
        return c.json({ error: 'Input must be in owner/repo format' }, 422);
      }

      const [owner, repo] = input.split('/');
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/README.md`;

      let response: Response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          response = await fetch(apiUrl, {
            signal: controller.signal,
            headers: {
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'Revenant/1.0',
            },
          });
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return c.json({ error: 'Repository not found or README missing' }, 422);
      }

      if (!response.ok) {
        return c.json({ error: 'Repository not found or README missing' }, 422);
      }

      let githubData: unknown;
      try {
        githubData = await response.json();
      } catch {
        return c.json({ error: 'Repository not found or README missing' }, 422);
      }

      if (
        typeof githubData !== 'object' ||
        githubData === null ||
        typeof (githubData as Record<string, unknown>)['content'] !== 'string'
      ) {
        return c.json({ error: 'Repository not found or README missing' }, 422);
      }

      const encoded = (githubData as Record<string, unknown>)['content'] as string;
      const decoded = atob(encoded.replace(/\n/g, ''));

      return c.json({ source: decoded, kind: 'markdown' });
    }
  } catch {
    // Never expose stack traces
    return c.json({ error: 'Internal error' }, 422);
  }
});

export default app;
