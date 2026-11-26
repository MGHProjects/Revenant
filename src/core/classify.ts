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
 * | 2xx + known rename, or same name under another suffix      | alive     | "Moved to {domain}."                                  |
 * |   (redirectKind 'moved'; checked before any snapshot row)  |           |                                                       |
 * | 2xx + other domain + snapshot text < 200 chars of live text| restless  | "Redirects to {domain}; the new page has too little   |
 * |                                                            |           | text to compare. Not judged."                         |
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
import { redirectKind } from './redirect-kind.ts';
import type { Probe, SnapshotResult, Verdict } from './types.ts';

/**
 * Minimum characters of live visible text for a similarity score to mean anything.
 * Measured 26 Nov 2026 (visibleText of the live page, characters): x.com home 431, twitter
 * status target 795, friendster.com 915 (sparsest real possessed target), codeplex.com target
 * microsoft.com 4875, exercism.org 6083, kiko.com target bestshop.com 8298, geocities.com
 * target yahoo.com 11230, myspace.com 27440. 200 is 4.5x under the sparsest possessed target
 * and 2x under x.com, and above a 404 stub (jaiku 88).
 */
export const MIN_LIVE_TEXT_CHARS = 200;

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
    const finalDomain = registrableDomain(hostnameOf(finalUrl));
    const kind = redirectKind(originalUrl, finalUrl);
    const crossDomain = kind !== 'same-site';

    // Order for a cross-domain 2xx, each check cheaper and less dependent than the next:
    //  1. A rename (known list, or same name under another suffix) needs no snapshot, so it
    //     comes first and holds even when the archive is down: a known rename is not
    //     "restless because the archive failed", and judgeLink never asks the archive for it.
    //  2. Archive unavailable / no copy: nothing to compare, whatever the live text is.
    //  3. Too little live text: only meaningful when a comparison would otherwise run, so it
    //     sits after the snapshot rows (snapshot 'none' stays alive) and before the score.
    //  4. The similarity score.
    if (kind === 'moved') {
      return { verdict: 'alive', reason: `Moved to ${finalDomain}.` };
    }

    if (crossDomain && snapshot?.status === 'unavailable') {
      // The archive could not be reached: we cannot compare, so we do not judge.
      return {
        verdict: 'restless',
        reason: `Redirects to ${finalDomain}; the archive could not be reached to compare. Not judged.`,
      };
    }

    if (crossDomain && snapshot?.status === 'text') {
      // Too little text: the score says nothing about a near-empty page (login wall, SPA shell).
      if ((probe.text ?? '').trim().length < MIN_LIVE_TEXT_CHARS) {
        return {
          verdict: 'restless',
          reason: `Redirects to ${finalDomain}; the new page has too little text to compare. Not judged.`,
        };
      }
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
