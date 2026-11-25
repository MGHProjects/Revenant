/**
 * scan(input, kind, fetcher, wayback, now) — async generator yielding ScanEvent.
 *
 * Used by CLI and MCP only. The Worker uses per-batch calls instead.
 *
 * Steps:
 *   1. Resolve input to source text + effective parse kind.
 *   2. extract(source, kind) → Link[]
 *   3. Cap at 200 links; emit meta event.
 *   4. guard() each link; failing links yield restless immediately.
 *   5. Pool of 6: fetch → optional 5xx retry → classify → optional epitaph/resurrection.
 *
 * Requirements: 1.3, 1.4, 1.6, 1.7, 2.2, 5.4
 */

import { extract } from '../core/extract.js';
import { guard } from '../core/guard.js';
import { classify } from '../core/classify.js';
import { registrableDomain } from '../core/domain.js';
import { shouldRetry } from './retry.js';
import type {
  Fetcher,
  Judgement,
  Link,
  ScanEvent,
  SnapshotResult,
  Wayback,
} from '../core/types.js';

export type InputKind = 'markdown' | 'html' | 'url' | 'repo';

const CAP = 200;
const POOL_SIZE = 6;
const RETRY_DELAY_MS = 2_000;
const USER_AGENT = 'Revenant/1.0';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Detect effective parse kind from raw text.
 * Returns 'html' if the text starts with an HTML doctype or root element,
 * otherwise 'markdown'.
 */
function detectKind(text: string): 'markdown' | 'html' {
  const trimmed = text.trimStart();
  if (
    trimmed.toLowerCase().startsWith('<!doctype html') ||
    trimmed.toLowerCase().startsWith('<html')
  ) {
    return 'html';
  }
  return 'markdown';
}

/**
 * Extract the hostname from a URL string; returns '' on parse failure.
 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Run at most `poolSize` async tasks concurrently, yielding results as they
 * complete. The generator receives tasks lazily via the `items` array.
 */
async function* poolMap<T, R>(
  items: T[],
  poolSize: number,
  fn: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  let index = 0;

  // Active promises paired with their resolve callbacks so we can track which
  // slot completed.
  type Slot = { promise: Promise<{ result: R; slotId: number }>; slotId: number };
  const slots = new Map<number, Slot>();
  let nextSlotId = 0;

  function launchNext(): void {
    if (index >= items.length) return;
    const item = items[index++]!;
    const slotId = nextSlotId++;
    const promise = fn(item).then(result => ({ result, slotId }));
    slots.set(slotId, { promise, slotId });
  }

  // Fill pool initially.
  for (let i = 0; i < Math.min(poolSize, items.length); i++) {
    launchNext();
  }

  while (slots.size > 0) {
    // Race all in-flight promises.
    const { result, slotId } = await Promise.race(
      Array.from(slots.values()).map(s => s.promise),
    );
    slots.delete(slotId);
    yield result;
    launchNext();
  }
}

// ---------------------------------------------------------------------------
// Per-link processing
// ---------------------------------------------------------------------------

interface ProcessResult {
  link: Link;
  judgement: Judgement;
}

async function processLink(
  link: Link,
  fetcher: Fetcher,
  wayback: Wayback,
): Promise<ProcessResult> {
  const url = link.url;

  // Fetch with the standard 8 s / 512 KB limits.
  let probe = await fetcher(url, { timeoutMs: 8_000, maxBytes: 524_288 });

  // 5xx: retry once after 2 seconds (Requirement 2.2).
  // The retry skips DNS confirmation (keeps the Worker's per-URL subrequest budget).
  if (shouldRetry(probe)) {
    await sleep(RETRY_DELAY_MS);
    probe = await fetcher(url, { timeoutMs: 8_000, maxBytes: 524_288, skipDns: true });
  }

  // Determine whether we need a snapshot text for the possessed check.
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
      snapshotText = await wayback.getSnapshotText(url);
    }
  }

  const { verdict, reason } = classify(probe, url, snapshotText);

  // Build base judgement.
  const judgement: Judgement = { link, verdict, reason };

  // Enrich with epitaph and resurrection for dead/possessed links.
  if (verdict === 'dead' || verdict === 'possessed') {
    judgement.epitaph = await wayback.getEpitaph(url);
    const resurrection = await wayback.getResurrection(url);
    if (resurrection !== undefined) {
      judgement.resurrection = resurrection;
    }
  }

  return { link, judgement };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function* scan(
  input: string,
  kind: InputKind,
  fetcher: Fetcher,
  wayback: Wayback,
  _now: Date,
): AsyncGenerator<ScanEvent> {
  // ---- Step 1: Resolve input ----

  let source: string;
  let effectiveKind: 'markdown' | 'html';

  if (kind === 'markdown' || kind === 'html') {
    source = input;
    effectiveKind = kind;
  } else if (kind === 'url') {
    const probe = await fetcher(input, { timeoutMs: 8_000, maxBytes: 524_288 });
    if (probe.outcome !== 'response' || probe.status === undefined || probe.status < 200 || probe.status > 299) {
      const reason =
        probe.outcome === 'timeout'
          ? 'timed out fetching URL'
          : probe.outcome === 'network-error'
            ? (probe.text ?? 'network error fetching URL')
            : `server returned ${probe.status ?? 'unknown status'} for URL`;
      yield { type: 'error', message: `Could not fetch ${input}: ${reason}` };
      return;
    }
    source = probe.text ?? '';
    effectiveKind = detectKind(source);
  } else {
    // kind === 'repo': parse "owner/repo" and fetch README from GitHub API.
    const parts = input.trim().split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      yield { type: 'error', message: `Invalid repo format '${input}': expected owner/repo` };
      return;
    }
    const [owner, repo] = parts as [string, string];
    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/README.md`;

    // We use the injected fetcher; it handles the HTTP call.
    const probe = await fetcher(apiUrl, { timeoutMs: 8_000, maxBytes: 524_288 });
    if (probe.outcome !== 'response' || probe.status === undefined || probe.status < 200 || probe.status > 299) {
      const reason =
        probe.outcome === 'timeout'
          ? 'timed out fetching repository README'
          : probe.outcome === 'network-error'
            ? (probe.text ?? 'network error')
            : `GitHub API returned ${probe.status ?? 'unknown status'}`;
      yield { type: 'error', message: `Could not fetch README for ${input}: ${reason}` };
      return;
    }

    // The GitHub Contents API returns JSON with a base64-encoded `content` field.
    let parsed: unknown;
    try {
      parsed = JSON.parse(probe.text ?? '');
    } catch {
      yield { type: 'error', message: `Could not parse GitHub API response for ${input}` };
      return;
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)['content'] !== 'string'
    ) {
      yield { type: 'error', message: `GitHub API response for ${input} is missing content field` };
      return;
    }

    // Decode base64 content; GitHub returns it with newlines every 60 chars.
    const encoded = ((parsed as Record<string, unknown>)['content'] as string).replace(/\n/g, '');
    try {
      source = atob(encoded);
    } catch {
      yield { type: 'error', message: `Could not decode README content for ${input}` };
      return;
    }
    effectiveKind = 'markdown';
  }

  // ---- Step 2: Extract ----

  const allLinks = extract(source, effectiveKind);

  // ---- Step 3: Cap ----

  const total = allLinks.length;
  const capped = total > CAP;
  const links = capped ? allLinks.slice(0, CAP) : allLinks;

  yield { type: 'meta', total, capped, capLimit: 200 };

  // ---- Step 4: Guard ----

  const passing: Link[] = [];

  for (const link of links) {
    const result = guard(link.url);
    if (!result.ok) {
      yield {
        type: 'judgement',
        judgement: {
          link,
          verdict: 'restless',
          reason: `Not checked: ${result.reason}.`,
        },
      };
    } else {
      passing.push(link);
    }
  }

  // ---- Step 5: Pool of 6 ----

  for await (const { judgement } of poolMap(passing, POOL_SIZE, link =>
    processLink(link, fetcher, wayback),
  )) {
    yield { type: 'judgement', judgement };
  }
}
