/**
 * registrableDomain(hostname) — returns the registrable domain for a hostname.
 *
 * The registrable domain is the last two labels of the hostname, except when
 * the last two labels form one of the recognised two-level effective TLDs
 * listed below, in which case the last three labels are taken.
 *
 * Recognised two-level effective TLDs:
 *   co.uk, com.au, org.uk, net.au, co.nz, org.nz, com.br, co.jp
 *
 * Examples:
 *   www.example.com   → example.com
 *   foo.bar.co.uk     → bar.co.uk
 *   example.co.uk     → example.co.uk
 *   github.com        → github.com
 *   api.github.com    → github.com
 *
 * Pure — no fetch, no globals.
 */

const TWO_LEVEL_TLDS = new Set([
  'co.uk',
  'com.au',
  'org.uk',
  'net.au',
  'co.nz',
  'org.nz',
  'com.br',
  'co.jp',
]);

export function registrableDomain(hostname: string): string {
  // Lowercase for consistent matching; trim any trailing dot (absolute hostname).
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const labels = h.split('.');

  if (labels.length <= 2) {
    // Already at or below the registrable domain level.
    return h;
  }

  // Check whether the last two labels form a known two-level effective TLD.
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_LEVEL_TLDS.has(lastTwo)) {
    // Need at least one label in front of the two-level TLD.
    if (labels.length <= 3) {
      // e.g. "example.co.uk" — already at registrable domain level.
      return h;
    }
    // e.g. "foo.bar.co.uk" → "bar.co.uk"
    return labels.slice(-3).join('.');
  }

  // Standard case: registrable domain is the last two labels.
  return lastTwo;
}
