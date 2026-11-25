/**
 * classify(probe, originalUrl, snapshot?) — maps a network Probe to a verdict.
 *
 * Decision table (first match wins). Reasons are plain sentences shared by web, CLI and MCP:
 *
 * | Condition                                                  | Verdict   | Reason                                                |
 * |------------------------------------------------------------|-----------|-------------------------------------------------------|
 * | outcome === 'timeout'                                      | restless  | "No answer within 8 s. Not judged."                   |
 * | network-error + dnsFailure (NXDOMAIN confirmed)            | dead      | "The domain no longer resolves."                      |
 * | network-error (any other)                                  | restless  | "Connection failed ({text}). Not judged." (no text:   |
 * |                                                            |           | "Connection failed. Not judged.")                     |
 * | status 401                                                 | restless  | "Answers 401: needs a login. Not judged."             |
 * | status 403, 429                                            | restless  | "Answers {status} to robots. Not judged."             |
 * | status 404 or 410                                          | dead      | "Answers {status}."                                   |
 * | status 5xx (retried)                                       | restless  | "Answers {status}, twice. Not judged."                |
 * | status 5xx (probe.noRetry)                                 | restless  | "Answers {status}. Not judged."                       |
 * | 2xx + other domain + snapshot + similarity < 0.2           | possessed | "Redirects to {domain}; {n}% like the archived page." |
 * | 2xx + other domain + snapshot + similarity >= 0.2          | alive     | "Answers {status} with the page you cited."           |
 * | 2xx + other domain + snapshot 'unavailable' (archive down) | restless  | "Redirects to {domain}; the archive could not be      |
 * |                                                            |           | reached to compare. Not judged."                      |
 * | 2xx + other domain + snapshot 'none' (or omitted)          | alive     | "Redirects to {domain}; no archived copy to compare." |
 * | 2xx                                                        | alive     | "Answers {status} with the page you cited."           |
 * | any other status                                           | restless  | "Answers {status}. Not judged."                       |
 * (Guard rejections are built by scan.ts and the Worker: "Not checked: {reason}.")
 *
 * Never returns `possessed` when finalUrl shares the same registrable domain
 * as originalUrl.
 *
 * Pure — no fetch, no Date.now(), no globals.
 */

import { similarity } from './similarity.ts';
import { registrableDomain } from './domain.ts';
import type { Probe, SnapshotResult, Verdict } from './types.ts';

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
  snapshot?: SnapshotResult,
): { verdict: Verdict; reason: string } {
  // Row 1: timeout
  if (probe.outcome === 'timeout') {
    return { verdict: 'restless', reason: 'No answer within 8 s. Not judged.' };
  }

  // Row 2: network-error
  if (probe.outcome === 'network-error') {
    if (probe.dnsFailure) {
      return { verdict: 'dead', reason: 'The domain no longer resolves.' };
    }
    return { verdict: 'restless', reason: probe.text ? `Connection failed (${probe.text}). Not judged.` : 'Connection failed. Not judged.' };
  }

  // From here on, outcome === 'response' and status is present.
  const status = probe.status ?? 0;

  // Row 3: 401 / 403 / 429
  if (status === 401) {
    return { verdict: 'restless', reason: 'Answers 401: needs a login. Not judged.' };
  }
  if (status === 403 || status === 429) {
    return { verdict: 'restless', reason: `Answers ${status} to robots. Not judged.` };
  }

  // Row 4: 404 / 410
  if (status === 404 || status === 410) {
    return { verdict: 'dead', reason: `Answers ${status}.` };
  }

  // Row 5: 5xx (after retry — the caller already retried once)
  if (status >= 500 && status <= 599) {
    if (probe.noRetry) {
      return { verdict: 'restless', reason: `Answers ${status}. Not judged.` };
    }
    return { verdict: 'restless', reason: `Answers ${status}, twice. Not judged.` };
  }

  // Rows 6–8: 2xx responses
  if (status >= 200 && status <= 299) {
    const finalUrl = probe.finalUrl ?? originalUrl;
    const origHost = hostnameOf(originalUrl);
    const finalHost = hostnameOf(finalUrl);
    const origDomain = registrableDomain(origHost);
    const finalDomain = registrableDomain(finalHost);
    const crossDomain = origDomain !== finalDomain && finalDomain !== '';

    if (crossDomain && snapshot?.status === 'unavailable') {
      // The archive could not be reached: we cannot compare, so we do not judge.
      return {
        verdict: 'restless',
        reason: `Redirects to ${finalDomain}; the archive could not be reached to compare. Not judged.`,
      };
    }

    if (crossDomain && snapshot?.status === 'text') {
      // Row 6: possessed check
      const score = similarity(probe.text ?? '', snapshot.text);
      if (score < 0.2) {
        const pct = Math.round(score * 100);
        return {
          verdict: 'possessed',
          reason: `Redirects to ${finalDomain}; ${pct}% like the archived page.`,
        };
      }
      // High similarity → still alive (falls through to row 8 via same-domain logic;
      // but strictly this is "2xx cross-domain with snapshotText and similarity ≥ 0.2"
      // which is not in the table — treat as alive per decision table exhaustion).
      return { verdict: 'alive', reason: `Answers ${status} with the page you cited.` };
    }

    if (crossDomain) {
      // Row 7: redirected to a different domain, no snapshot to compare
      return { verdict: 'alive', reason: `Redirects to ${finalDomain}; no archived copy to compare.` };
    }

    // Row 8: same domain or no redirect
    return { verdict: 'alive', reason: `Answers ${status} with the page you cited.` };
  }

  // Any other status (1xx, 3xx that wasn't followed, etc.) — treat as restless
  return { verdict: 'restless', reason: `Answers ${status}. Not judged.` };
}
