import { guard } from '../core/guard.js';
import type { Fetcher, Probe } from '../core/types.js';
import { confirmNoDns } from './dns.js';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 524_288; // 512 KB
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Revenant/1.0';

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
    return { outcome: 'network-error', text: initialGuard.reason };
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
        await response.body?.cancel().catch(() => undefined);
        const dns = await confirmNoDns(hostnameOf(currentUrl));
        if (dns.confirmed) {
          return {
            outcome: 'network-error',
            text: `HTTP ${DNS_ERROR_STATUS} (DNS error)`,
            dnsFailure: true,
          };
        }
        // Two queries spent: a retry plus Wayback would break the per-URL budget.
        return {
          outcome: 'response',
          status: response.status,
          finalUrl: currentUrl,
          text: '',
          ...(dns.queries >= 2 ? { noRetry: true as const } : {}),
        };
      }

      // Handle redirects manually.
      if (response.status >= 300 && response.status < 400) {
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
          return { outcome: 'network-error', text: guardResult.reason };
        }

        currentUrl = resolvedLocation;
        redirectCount++;
        continue;
      }

      // Non-redirect: read body up to maxBytes.
      let text = '';
      try {
        const reader = response.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          let bytesRead = 0;
          const chunks: string[] = [];

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const remaining = maxBytes - bytesRead;
            if (value.length >= remaining) {
              // Truncate at the cap — not an error.
              chunks.push(decoder.decode(value.slice(0, remaining), { stream: false }));
              bytesRead += remaining;
              // Cancel the stream so we don't hold the connection open.
              await reader.cancel();
              break;
            }

            chunks.push(decoder.decode(value, { stream: true }));
            bytesRead += value.length;
          }

          text = chunks.join('');
        } else {
          text = await response.text();
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          return { outcome: 'timeout' };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { outcome: 'network-error', text: message };
      }

      return {
        outcome: 'response',
        status: response.status,
        finalUrl: currentUrl,
        text,
      };
    }
  } finally {
    clearTimeout(timer);
  }
};
