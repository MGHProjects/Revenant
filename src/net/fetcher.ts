import { guard } from '../core/guard.js';
import type { Fetcher, Probe } from '../core/types.js';
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

export const fetcher: Fetcher = async (
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
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let currentUrl = url;
  let redirectCount = 0;

  try {
    while (true) {
      let response: Response;
      try {
        response = await fetch(currentUrl, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': USER_AGENT },
        });
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          return { outcome: 'timeout' };
        }
        const message = err instanceof Error ? err.message : String(err);
        if (!skipDns && (await confirmNoDns(hostnameOf(currentUrl))).confirmed) {
          return { outcome: 'network-error', text: message, dnsFailure: true };
        }
        return { outcome: 'network-error', text: message };
      }

      // On Workers an unresolvable host answers 530 instead of throwing. Confirm with DNS.
      if (response.status === DNS_ERROR_STATUS && !skipDns) {
        await discardBody(response);
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
          status: response.status,
          finalUrl: currentUrl,
          text: '',
          ...(dns.queries >= 1 ? { noRetry: true as const } : {}),
        };
      }

      // Handle redirects manually.
      if (response.status >= 300 && response.status < 400) {
        // The 3xx body is never read: release the connection before following or giving up.
        await discardBody(response);
        if (redirectCount >= MAX_REDIRECTS) {
          return { outcome: 'network-error', text: 'too many redirects' };
        }

        const location = response.headers.get('Location');
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

      // Non-redirect: read body up to maxBytes.
      let text = '';
      try {
        text = decodeUtf8(await readCapped(response, maxBytes));
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          return { outcome: 'timeout' };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { outcome: 'network-error', text: message };
      }

      const contentType = response.headers.get('content-type');
      return {
        outcome: 'response',
        status: response.status,
        finalUrl: currentUrl,
        text,
        ...(contentType ? { contentType } : {}),
      };
    }
  } finally {
    clearTimeout(timer);
  }
};
