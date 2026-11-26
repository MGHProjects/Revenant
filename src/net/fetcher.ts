import { guard } from '../core/guard.js';
import type { Fetcher, Probe } from '../core/types.js';
import { isArchiveHost, parseRetryAfter, realClock } from './archive-queue.js';
import type { ArchiveQueue } from './archive-queue.js';
import { confirmNoDns } from './dns.js';
import { decodeUtf8, discardBody, MAX_BODY_BYTES, readCapped } from './read-capped.js';
import { USER_AGENT } from './user-agent.js';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = MAX_BODY_BYTES; // 512 KB
const MAX_REDIRECTS = 5;
/** Requests one fetch call can make: the first plus every redirect. */
export const MAX_HOPS = MAX_REDIRECTS + 1;

/** Cloudflare error 1016 (origin DNS error) arrives as HTTP 530 on Workers. */
const DNS_ERROR_STATUS = 530;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** What one request (one hop) came to, with its body already read or released. */
interface Step {
  /** The request threw or its body read failed. */
  error?: { err: unknown; timedOut: boolean; onRequest: boolean };
  status?: number;
  retryAfter?: string | null;
  kind?: 'dns530' | 'redirect' | 'body';
  location?: string | null;
  text?: string;
  contentType?: string | null;
}

export interface FetcherOptions {
  /**
   * When set, every hop whose host is the Internet Archive (web.archive.org, archive.org,
   * *.archive.org) waits for this queue and runs inside it. The hop is checked per request, so
   * a redirect that lands on the archive on any hop is queued too. The guard still runs on every
   * hop and the limit stays 5 redirects.
   */
  archiveQueue?: ArchiveQueue;
}

export function createFetcher(options: FetcherOptions = {}): Fetcher {
  const queue = options.archiveQueue;
  const clock = queue?.clock ?? realClock;

  return async (
    url: string,
    init?: { timeoutMs: number; maxBytes: number; skipDns?: boolean },
  ): Promise<Probe> => {
    const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = init?.maxBytes ?? DEFAULT_MAX_BYTES;
    const skipDns = init?.skipDns === true;

    // Validate the initial URL before any network activity.
    const initialGuard = guard(url);
    if (!initialGuard.ok) {
      return { outcome: 'network-error', text: initialGuard.reason, blocked: true };
    }

    const controller = new AbortController();
    // The call's timeout is a budget that does not run while a hop waits in the archive queue.
    let remaining = timeoutMs;
    let armedAt = 0;
    let timer: unknown;
    const arm = (): void => {
      armedAt = clock.now();
      timer = clock.setTimeout(() => controller.abort(), Math.max(0, remaining));
    };
    const disarm = (): void => {
      clock.clearTimeout(timer);
      remaining -= clock.now() - armedAt;
    };

    /** One request: fetch, then read or release the body. Never throws. */
    const step = async (target: string, signal: AbortSignal): Promise<Step> => {
      let response: Response;
      try {
        response = await fetch(target, {
          redirect: 'manual',
          signal,
          headers: { 'User-Agent': USER_AGENT },
        });
      } catch (err: unknown) {
        return { error: { err, timedOut: signal.aborted, onRequest: true } };
      }
      const status = response.status;
      const retryAfter = response.headers.get('Retry-After');

      // On Workers an unresolvable host answers 530 instead of throwing. Confirm with DNS.
      if (status === DNS_ERROR_STATUS && !skipDns) {
        await discardBody(response);
        return { status, retryAfter, kind: 'dns530' };
      }

      if (status >= 300 && status < 400) {
        // The 3xx body is never read: release the connection before following or giving up.
        await discardBody(response);
        return { status, retryAfter, kind: 'redirect', location: response.headers.get('Location') };
      }

      // Non-redirect: read body up to maxBytes.
      try {
        const text = decodeUtf8(await readCapped(response, maxBytes));
        return { status, retryAfter, kind: 'body', text, contentType: response.headers.get('content-type') };
      } catch (err: unknown) {
        return { error: { err, timedOut: signal.aborted, onRequest: false } };
      }
    };

    let currentUrl = url;
    let redirectCount = 0;
    arm();

    try {
      while (true) {
        let result: Step;
        if (queue !== undefined && isArchiveHost(hostnameOf(currentUrl))) {
          // Wait in line with the timer paused; the hop's timeout starts when the hop starts.
          disarm();
          let startedAt = clock.now();
          try {
            result = await queue.run(
              async signal => {
                startedAt = clock.now();
                const s = await step(currentUrl, signal);
                if (s.status === 429 || s.status === 503) {
                  const ms = parseRetryAfter(s.retryAfter, clock.now());
                  if (ms !== undefined) queue.penalize(ms);
                }
                return s;
              },
              { timeoutMs: Math.max(0, remaining) },
            );
          } catch (err: unknown) {
            // The queue released a hop that outlived its time.
            result = { error: { err, timedOut: true, onRequest: true } };
          }
          remaining -= clock.now() - startedAt;
          arm();
        } else {
          result = await step(currentUrl, controller.signal);
        }

        if (result.error) {
          if (result.error.timedOut || controller.signal.aborted) return { outcome: 'timeout' };
          const message = result.error.err instanceof Error ? result.error.err.message : String(result.error.err);
          // A throw on the request (not on the body) may be a DNS failure; a body-read failure is not.
          if (result.error.onRequest && !skipDns && (await confirmNoDns(hostnameOf(currentUrl))).confirmed) {
            return { outcome: 'network-error', text: message, dnsFailure: true };
          }
          return { outcome: 'network-error', text: message };
        }

        if (result.kind === 'dns530') {
          const dns = await confirmNoDns(hostnameOf(currentUrl));
          if (dns.confirmed) {
            return {
              outcome: 'network-error',
              text: `HTTP ${DNS_ERROR_STATUS} (DNS error)`,
              dnsFailure: true,
            };
          }
          // Any DoH query spent: a retry plus Wayback would break the per-URL subrequest budget.
          return {
            outcome: 'response',
            status: result.status!,
            finalUrl: currentUrl,
            text: '',
            ...(dns.queries >= 1 ? { noRetry: true as const } : {}),
          };
        }

        // Handle redirects manually.
        if (result.kind === 'redirect') {
          if (redirectCount >= MAX_REDIRECTS) {
            return { outcome: 'network-error', text: 'too many redirects' };
          }

          const location = result.location;
          if (!location) {
            return { outcome: 'network-error', text: 'redirect with no Location header' };
          }

          // Resolve relative Location values against the current URL.
          let resolvedLocation: string;
          try {
            resolvedLocation = new URL(location, currentUrl).href;
          } catch {
            return { outcome: 'network-error', text: `invalid redirect Location: ${location}` };
          }

          const guardResult = guard(resolvedLocation);
          if (!guardResult.ok) {
            return { outcome: 'network-error', text: guardResult.reason, blocked: true };
          }

          currentUrl = resolvedLocation;
          redirectCount++;
          continue;
        }

        return {
          outcome: 'response',
          status: result.status!,
          finalUrl: currentUrl,
          text: result.text ?? '',
          ...(result.contentType ? { contentType: result.contentType } : {}),
        };
      }
    } finally {
      clock.clearTimeout(timer);
    }
  };
}

/** The plain fetcher: no archive queue. The CLI, MCP and the Worker build their own with createFetcher. */
export const fetcher: Fetcher = createFetcher();