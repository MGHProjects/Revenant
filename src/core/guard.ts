/**
 * guard(url) — validates a URL against Requirement 5.1.
 *
 * Returns { ok: true } for safe public URLs, or { ok: false, reason } for any
 * URL that the fetcher must refuse: wrong scheme, credentials, IP literal
 * (in any notation), private/loopback/CGNAT ranges, or blocked hostname.
 *
 * Note: the WHATWG URL parser normalises non-dotted IPv4 forms (hex, octal,
 * integer) to standard dotted-decimal before we see them in `hostname`, so
 * `parseIPv4` only needs to handle dotted-decimal. For IPv6, `parsed.hostname`
 * includes square brackets (e.g. `[::1]`) which we strip before analysis.
 */

type GuardResult = { ok: true } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a standard dotted-decimal IPv4 string (1–4 parts) into a 32-bit
 *  unsigned integer, or return undefined if the string is not of that form. */
function parseIPv4(host: string): number | undefined {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return undefined;

  const nums: number[] = [];
  for (const part of parts) {
    if (part === '' || !/^[0-9]+$/.test(part)) return undefined;
    const n = Number(part);
    if (!Number.isFinite(n) || n < 0) return undefined;
    nums.push(n);
  }

  // Single part: full 32-bit integer (URL parser already normalised hex/octal
  // to decimal, but we also handle bare-decimal integers here just in case).
  if (nums.length === 1) {
    const v = nums[0];
    if (v > 0xffffffff) return undefined;
    return v >>> 0;
  }
  // Two parts: a.b — a is top 8 bits, b is bottom 24 bits.
  if (nums.length === 2) {
    if (nums[0] > 0xff || nums[1] > 0xffffff) return undefined;
    return (((nums[0] << 24) | nums[1]) >>> 0);
  }
  // Three parts: a.b.c — a is 8, b is 8, c is 16.
  if (nums.length === 3) {
    if (nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return undefined;
    return (((nums[0] << 24) | (nums[1] << 16) | nums[2]) >>> 0);
  }
  // Four parts: standard dotted-decimal.
  if (nums.some(n => n > 0xff)) return undefined;
  return (((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0);
}

/** Returns true if a 32-bit IPv4 address falls in a blocked range. */
function isBlockedIPv4(ip: number): boolean {
  // JavaScript bitwise operators produce signed 32-bit results, so we must
  // compare using unsigned right-shift (>>> 0) to stay in positive territory
  // for addresses above 0x7fffffff.
  const u = ip >>> 0;
  // 0.0.0.0/8      — 0x00000000 – 0x00ffffff
  if ((u >>> 24) === 0x00) return true;
  // 10.0.0.0/8     — 0x0a000000 – 0x0affffff
  if ((u >>> 24) === 0x0a) return true;
  // 100.64.0.0/10  — 0x64400000 – 0x647fffff (CGNAT)
  if ((u >>> 22) === (0x64400000 >>> 22)) return true;
  // 127.0.0.0/8    — 0x7f000000 – 0x7fffffff
  if ((u >>> 24) === 0x7f) return true;
  // 169.254.0.0/16 — 0xa9fe0000 – 0xa9feffff
  if ((u >>> 16) === 0xa9fe) return true;
  // 172.16.0.0/12  — 0xac100000 – 0xac1fffff
  if ((u >>> 20) === (0xac100000 >>> 20)) return true;
  // 192.168.0.0/16 — 0xc0a80000 – 0xc0a8ffff
  if ((u >>> 16) === 0xc0a8) return true;
  return false;
}

/**
 * Returns true if the bare IPv6 address (brackets already stripped) falls in
 * a blocked IPv6 range, or embeds a blocked IPv4 address.
 *
 * The WHATWG URL parser normalises IPv6 to lowercase hex groups, so we work
 * with that normalised form.
 */
function isBlockedIPv6(addr: string): boolean {
  const a = addr.toLowerCase();

  // ::1  loopback
  if (a === '::1') return true;

  // Parse all groups to a 128-bit value for range checks.
  // We rely on the WHATWG normalisation: groups are compact hex, '::' is used
  // for the longest run of zeroes.
  const groups = expandIPv6(a);
  if (groups === null) return false; // unparseable — allow, don't block

  // fe80::/10  link-local — first group starts with 0b1111111010xxxxxx
  // The first 16-bit group must be in [0xfe80, 0xfebf].
  const g0 = groups[0];
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return true;

  // fc00::/7  ULA — first group: top 7 bits are 1111110
  // 0xfc00 – 0xfdff
  if (g0 >= 0xfc00 && g0 <= 0xfdff) return true;

  // ::ffff:0:0/96  IPv4-mapped — first 5 groups are 0, group 5 is 0xffff,
  // groups 6–7 are the IPv4 address in two 16-bit halves.
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
    groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff
  ) {
    const ipv4 = ((groups[6] << 16) | groups[7]) >>> 0;
    return isBlockedIPv4(ipv4);
  }

  return false;
}

/**
 * Expand a normalised IPv6 address string into an array of 8 unsigned 16-bit
 * integers. Returns null if the string cannot be parsed.
 */
function expandIPv6(addr: string): number[] | null {
  // Split on '::' first to find the compressed zero run.
  const halves = addr.split('::');
  if (halves.length > 2) return null; // multiple '::' — invalid

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  // Handle IPv4-compatible tail in the right half (e.g. '::ffff:192.168.1.1'
  // is already normalised by WHATWG to '::ffff:c0a8:101', but handle it anyway).
  const result: number[] = [];

  const parseGroup = (s: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(s)) return null;
    return parseInt(s, 16);
  };

  for (const g of left) {
    const v = parseGroup(g);
    if (v === null) return null;
    result.push(v);
  }

  const zeros = 8 - left.length - right.length;
  if (zeros < 0) return null;

  // Add the compressed zeros.
  if (halves.length === 2) {
    for (let i = 0; i < zeros; i++) result.push(0);
    for (const g of right) {
      const v = parseGroup(g);
      if (v === null) return null;
      result.push(v);
    }
  }

  if (result.length !== 8) return null;
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function guard(url: string): GuardResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }

  // 1. Scheme must be http or https.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `scheme '${parsed.protocol.replace(/:$/, '')}' is not http or https` };
  }

  // 2. No credentials (userinfo).
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'URL contains credentials (userinfo)' };
  }

  // `parsed.hostname` for IPv6 URLs includes brackets: "[::1]".
  // For everything else it is the bare hostname or dotted-decimal IP.
  const rawHostname = parsed.hostname;

  // 3. IPv6 literals — hostname is wrapped in brackets by the WHATWG parser.
  if (rawHostname.startsWith('[') && rawHostname.endsWith(']')) {
    const addr = rawHostname.slice(1, -1);
    if (isBlockedIPv6(addr)) {
      return { ok: false, reason: `IPv6 address ${addr} is in a blocked range` };
    }
    // Non-blocked IPv6 is allowed.
    return { ok: true };
  }

  const hostname = rawHostname;

  // 4. Blocked hostnames.
  if (hostname === 'localhost') {
    return { ok: false, reason: 'hostname is localhost' };
  }
  if (hostname.endsWith('.local')) {
    return { ok: false, reason: 'hostname ends in .local' };
  }
  if (hostname.endsWith('.internal')) {
    return { ok: false, reason: 'hostname ends in .internal' };
  }
  if (hostname.endsWith('.localhost')) {
    return { ok: false, reason: 'hostname ends in .localhost' };
  }

  // 5. IPv4 in dotted-decimal (the URL parser normalised hex/octal/integer
  //    forms to dotted-decimal already).
  const ip = parseIPv4(hostname);
  if (ip !== undefined) {
    if (isBlockedIPv4(ip)) {
      return { ok: false, reason: `IP address ${hostname} is in a blocked range` };
    }
    // A public IPv4 is allowed.
    return { ok: true };
  }

  // 6. All checks passed.
  return { ok: true };
}
