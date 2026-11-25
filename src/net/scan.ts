/**
 * scan(input, kind, fetcher, wayback) — async generator yielding ScanEvent.
 *
 * Used by CLI and MCP only. The Worker calls judgeLink per URL instead.
 *
 * Steps:
 *   1. Resolve input to source text + effective parse kind.
 *   2. extract(source, kind) → Link[]
 *   3. Cap at 200 links; emit meta event.
 *   4. Pool of 6 over judgeLink (src/net/judge-link.ts): guard, fetch, retry, classify, epitaph.
 *
 * Requirements: 1.3, 1.4, 1.6, 1.7, 2.2, 5.4
 */

import { extract } from '../core/extract.js';
import { resolveRepoReadme } from './github-readme.js';
import { defaultSleep, judgeLink } from './judge-link.js';
import type {
  Fetcher,
  ScanEvent,
  Wayback,
} from '../core/types.js';

export type InputKind = 'markdown' | 'html' | 'url' | 'repo';

const CAP = 200;
const POOL_SIZE = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Public API
// ---------------------------------------------------------------------------

export async function* scan(
  input: string,
  kind: InputKind,
  fetcher: Fetcher,
  wayback: Wayback,
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
    // kind === 'repo': shared GitHub README resolver (same one the Worker uses).
    const result = await resolveRepoReadme(input.trim());
    if (!result.ok) {
      yield { type: 'error', message: result.message };
      return;
    }
    source = result.source;
    effectiveKind = result.kind;
  }
  // ---- Step 2: Extract ----

  const allLinks = extract(source, effectiveKind);

  // ---- Step 3: Cap ----

  const total = allLinks.length;
  const capped = total > CAP;
  const links = capped ? allLinks.slice(0, CAP) : allLinks;

  yield { type: 'meta', total, capped, capLimit: 200 };

  // ---- Step 4: Pool of 6 (judgeLink guards, fetches, retries, classifies) ----

  const deps = { fetcher, wayback, sleep: defaultSleep };
  for await (const judgement of poolMap(links, POOL_SIZE, link => judgeLink(link, deps))) {
    yield { type: 'judgement', judgement };
  }
}
