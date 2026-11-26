/**
 * judgeLink(link, deps, options) — the one per-link judgement used by the Worker, the CLI and MCP.
 *
 * Steps: guard → fetch (8 s, 512 KB) → one retry after 2 s on 5xx (skipDns) →
 * cross-domain snapshot lookup (skipped for a rename, see redirectKind) → visibleText of the live body (both sides capped if
 * options.textCap is set) → classify → epitaph and resurrection for dead/possessed.
 *
 * This is the single place the Worker subrequest budget refers to. Free plan: 50
 * subrequests per request, every fetch counts (each redirect hop, DoH query, Wayback call and
 * retry), and so do Cache API match/put calls, which is why the Worker makes none. 3 URLs per
 * /api/scan call, so a URL may use at most 16 (PER_URL_WORST_CASE, 3 x 16 = 48).
 *
 *   path                                              first   retry   DoH   CDX   id_   total
 *   5xx twice, then cross-domain 2xx (the worst)        6       6      0     2     2     16
 *   thrown fetch on the 6th hop, DNS confirmed dead     6       0      2     2     0     10
 *   530 on the 6th hop, any DoH query: not retried      6       0    1-2     0     0      8
 *
 *   CDX and id_ are 1 call plus 1 retry after a 429. The CDX is requested once per judgement
 *   (getArchive), shared by the cross-domain check and the epitaph/resurrection.
 *   The retry passes skipDns, so it never makes DoH queries.
 * * Requirements: 2.2, 3, 5, 6.1
 */

import { guard } from '../core/guard.js';
import { classify } from '../core/classify.js';
import { redirectKind } from '../core/redirect-kind.js';
import { visibleText } from '../core/visible-text.js';
import { MAX_HOPS } from './fetcher.js';
import { shouldRetry } from './retry.js';
import type { ArchiveAnswer, Fetcher, Judgement, Link, Probe, SnapshotResult, Wayback } from '../core/types.js';

export interface JudgeDeps {
  fetcher: Fetcher;
  wayback: Wayback;
  sleep: (ms: number) => Promise<void>;
}

export interface JudgeOptions {
  /** Max characters of visible text kept on each side before classify. Unset = uncapped. */
  textCap?: number;
}

const TIMEOUT_MS = 8_000;
const MAX_BYTES = 524_288; // 512 KB
const RETRY_DELAY_MS = 2_000;

/** Free-plan limit on subrequests (fetch calls and Cache API calls) per Worker invocation. */
export const WORKER_SUBREQUEST_LIMIT = 50;
const DOH_QUERIES = 2;
/** Wayback CDX lookup: 1 call plus 1 retry after a 429. */
const CDX_CALLS = 2;
/** Wayback id_ snapshot body: 1 call plus 1 retry after a 429. */
const SNAPSHOT_CALLS = 2;

/** Worst case subrequests for one URL (see the table above). Tested against real judgeLink runs. */
export const PER_URL_WORST_CASE = Math.max(
  2 * MAX_HOPS + CDX_CALLS + SNAPSHOT_CALLS,
  MAX_HOPS + DOH_QUERIES + CDX_CALLS,
);

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export async function judgeLink(
  link: Link,
  deps: JudgeDeps,
  options: JudgeOptions = {},
): Promise<Judgement> {
  const { fetcher, wayback, sleep } = deps;
  const { textCap } = options;
  const url = link.url;
  const cap = (s: string): string => (textCap === undefined ? s : s.slice(0, textCap));

  const guarded = guard(url);
  if (!guarded.ok) {
    return { link, verdict: 'restless', reason: `Not checked: ${guarded.reason}.` };
  }

  // At most one CDX request per judgement, shared by the cross-domain check and the epitaph.
  let archiveAnswer: ArchiveAnswer | undefined;
  const archive = async (): Promise<ArchiveAnswer> => (archiveAnswer ??= await wayback.getArchive(url));

  let probe = await fetcher(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });

  // 5xx: retry once after 2 s (Requirement 2.2). The retry skips DNS confirmation.
  if (shouldRetry(probe)) {
    await sleep(RETRY_DELAY_MS);
    probe = await fetcher(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, skipDns: true });
  }

  const is2xx =
    probe.outcome === 'response' &&
    probe.status !== undefined &&
    probe.status >= 200 &&
    probe.status <= 299;

  // Snapshot lookup only for a cross-domain 2xx. The Wayback client returns visible text.
  let snapshot: SnapshotResult | undefined;
  if (is2xx && probe.finalUrl !== undefined) {
    // A rename (known list or same name, other suffix) is decided without the archive.
    if (redirectKind(url, probe.finalUrl) === 'other') {
      const raw = await wayback.getSnapshotText(url, await archive());
      snapshot = raw.status === 'text' ? { status: 'text', text: cap(raw.text) } : raw;
    }
  }

  // Same transformation on both sides: visible text, then the cap.
  // Non-2xx probes keep their text (a network-error message is not HTML).
  const judged: Probe =
    is2xx && probe.text !== undefined ? { ...probe, text: cap(visibleText(probe.text)) } : probe;

  const { verdict, reason } = classify(judged, url, snapshot);
  const judgement: Judgement = { link, verdict, reason };
  // The one place the flag is set, from structured values only (never from reason text).
  if (verdict === 'restless' && snapshot?.status === 'unavailable') judgement.archiveUnavailable = true;

  if (verdict === 'dead' || verdict === 'possessed') {
    // One CDX answer yields both, or neither. Reused if the cross-domain check already asked.
    const answer = await archive();
    if (typeof answer.epitaph === 'object' && answer.resurrection !== undefined) {
      judgement.epitaph = answer.epitaph;
      judgement.resurrection = answer.resurrection;
    } else {
      judgement.epitaph = typeof answer.epitaph === 'object' ? 'unavailable' : answer.epitaph;
      if (judgement.epitaph === 'unavailable') judgement.archiveUnavailable = true;
    }
  }

  return judgement;
}
