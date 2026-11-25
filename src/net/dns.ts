const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 3_000;
const USER_AGENT = 'Revenant/1.0';

const TYPE_A = 1;
const TYPE_AAAA = 28;

export interface DnsDeps {
  /** Defaults to the global fetch, looked up at call time. */
  fetch?: typeof fetch;
}

export interface DnsConfirmation {
  /** True only when DNS proves the host has no A/AAAA record (NXDOMAIN or empty answers). */
  confirmed: boolean;
  /** How many DoH requests were made (0 to 2). */
  queries: number;
}

type DohAnswer = { Status?: unknown; Answer?: Array<{ type?: unknown }> };

async function query(host: string, type: 'A' | 'AAAA', f: typeof fetch): Promise<DohAnswer | undefined> {
  try {
    const res = await f(`${DOH_URL}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: 'application/dns-json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as unknown;
    return typeof body === 'object' && body !== null ? (body as DohAnswer) : undefined;
  } catch {
    return undefined;
  }
}

function hasAddress(a: DohAnswer, rrType: number): boolean {
  return Array.isArray(a.Answer) && a.Answer.some(r => r?.type === rrType);
}

/**
 * Confirm with DNS-over-HTTPS that a host has no address record. Never throws.
 * A: Status 3 -> confirmed. Status 0 without an A answer -> ask AAAA once; Status 0
 * without an AAAA answer -> confirmed. Anything else -> not confirmed.
 * CNAME-only answers count as "no record".
 */
export async function confirmNoDns(host: string, deps: DnsDeps = {}): Promise<DnsConfirmation> {
  if (!host) return { confirmed: false, queries: 0 };
  const f = deps.fetch ?? globalThis.fetch;

  const a = await query(host, 'A', f);
  if (a === undefined) return { confirmed: false, queries: 1 };
  if (a.Status === 3) return { confirmed: true, queries: 1 };
  if (a.Status !== 0 || hasAddress(a, TYPE_A)) return { confirmed: false, queries: 1 };

  const aaaa = await query(host, 'AAAA', f);
  if (aaaa === undefined) return { confirmed: false, queries: 2 };
  if (aaaa.Status === 3) return { confirmed: true, queries: 2 };
  if (aaaa.Status !== 0 || hasAddress(aaaa, TYPE_AAAA)) return { confirmed: false, queries: 2 };
  return { confirmed: true, queries: 2 };
}
