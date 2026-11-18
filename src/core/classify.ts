/**
 * classify(probe, originalUrl, snapshotText?) — maps a network Probe to a verdict.
 *
 * Decision table (first match wins):
 *
 * | Condition                                                              | Verdict    | Reason                                   |
 * |------------------------------------------------------------------------|------------|------------------------------------------|
 * | outcome === 'timeout'                                                  | restless   | "timed out after 8 s"                    |
 * | outcome === 'network-error'                                            | dead       | connection error message                 |
 * | status is 401, 403, or 429                                             | restless   | "{status} {statusText}"                  |
 * | status is 404 or 410                                                   | dead       | "{status} {statusText}"                  |
 * | status is 5xx (after retry)                                            | restless   | "{status} after retry"                   |
 * | 2xx + different domain + snapshotText + similarity < 0.2              | possessed  | "content {score}% similar to {year} cap" |
 * | 2xx + different domain + no snapshotText                               | alive      | "redirected to {newDomain}"              |
 * | 2xx                                                                    | alive      | "{status} OK"                            |
 *
 * Never returns `possessed` when finalUrl shares the same registrable domain
 * as originalUrl.
 *
 * Pure — no fetch, no Date.now(), no globals.
 */

import { similarity } from './similarity.ts';
import { registrableDomain } from './domain.ts';
import type { Probe, Verdict } from './types.ts';

/** HTTP status text for the codes used in the decision table. */
function statusText(status: number): string {
  const texts: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    410: 'Gone',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return texts[status] ?? 'Unknown';
}

/** Extract the hostname from a URL string. Returns '' on parse failure. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function classify(
  probe: Probe,
  originalUrl: string,
  snapshotText?: string,
): { verdict: Verdict; reason: string } {
  // Row 1: timeout
  if (probe.outcome === 'timeout') {
    return { verdict: 'restless', reason: 'timed out after 8 s' };
  }

  // Row 2: network-error
  if (probe.outcome === 'network-error') {
    return { verdict: 'dead', reason: probe.text ?? 'connection error' };
  }

  // From here on, outcome === 'response' and status is present.
  const status = probe.status ?? 0;

  // Row 3: 401 / 403 / 429
  if (status === 401 || status === 403 || status === 429) {
    return { verdict: 'restless', reason: `${status} ${statusText(status)}` };
  }

  // Row 4: 404 / 410
  if (status === 404 || status === 410) {
    return { verdict: 'dead', reason: `${status} ${statusText(status)}` };
  }

  // Row 5: 5xx (after retry — the caller already retried once)
  if (status >= 500 && status <= 599) {
    return { verdict: 'restless', reason: `${status} after retry` };
  }

  // Rows 6–8: 2xx responses
  if (status >= 200 && status <= 299) {
    const finalUrl = probe.finalUrl ?? originalUrl;
    const origHost = hostnameOf(originalUrl);
    const finalHost = hostnameOf(finalUrl);
    const origDomain = registrableDomain(origHost);
    const finalDomain = registrableDomain(finalHost);
    const crossDomain = origDomain !== finalDomain && finalDomain !== '';

    if (crossDomain && snapshotText !== undefined) {
      // Row 6: possessed check
      const score = similarity(probe.text ?? '', snapshotText);
      if (score < 0.2) {
        const pct = Math.round(score * 100);
        // classify() receives the snapshot body text, not the snapshot URL or its
        // timestamp. The year label defaults to 'archived' here; the scan orchestrator
        // (task 6.3) can refine the reason once it has the Epitaph.
        return {
          verdict: 'possessed',
          reason: `content ${pct}% similar to archived capture`,
        };
      }
      // High similarity → still alive (falls through to row 8 via same-domain logic;
      // but strictly this is "2xx cross-domain with snapshotText and similarity ≥ 0.2"
      // which is not in the table — treat as alive per decision table exhaustion).
      return { verdict: 'alive', reason: `${status} OK` };
    }

    if (crossDomain && snapshotText === undefined) {
      // Row 7: redirected to a different domain, no snapshot to compare
      return { verdict: 'alive', reason: `redirected to ${finalDomain}` };
    }

    // Row 8: same domain or no redirect
    return { verdict: 'alive', reason: `${status} OK` };
  }

  // Any other status (1xx, 3xx that wasn't followed, etc.) — treat as restless
  return { verdict: 'restless', reason: `${status} ${statusText(status)}` };
}
