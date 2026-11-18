/**
 * Unit tests for guard() — Requirement 5.1
 *
 * Covers every blocked category the spec names:
 *   - Blocked IPv4 ranges (all seven)
 *   - Non-standard IPv4 notation: hex, octal, integer (normalised by WHATWG URL parser)
 *   - IPv4-mapped IPv6 (::ffff:...)
 *   - Blocked IPv6 addresses: loopback, link-local, ULA
 *   - Blocked hostnames: localhost, *.local, *.internal, *.localhost
 *   - Bad schemes: ftp, file, javascript
 *   - Credentials (userinfo)
 *   - Valid public URLs that must pass
 */

import { describe, it, expect } from 'vitest';
import { guard } from '#core';

// ---------------------------------------------------------------------------
// Helper: assert a URL is blocked (ok === false)
// ---------------------------------------------------------------------------
function blocked(url: string): void {
  const result = guard(url);
  expect(result.ok, `expected '${url}' to be blocked but got ok=true`).toBe(false);
}

// Helper: assert a URL is allowed (ok === true)
function allowed(url: string): void {
  const result = guard(url);
  expect(result.ok, `expected '${url}' to be allowed but got ok=false, reason: ${!result.ok ? result.reason : ''}`).toBe(true);
}

// ---------------------------------------------------------------------------
// Scheme checks
// ---------------------------------------------------------------------------
describe('scheme', () => {
  it('allows http://', () => allowed('http://example.com/path'));
  it('allows https://', () => allowed('https://example.com/path'));
  it('blocks ftp://', () => blocked('ftp://example.com/file.txt'));
  it('blocks file://', () => blocked('file:///etc/passwd'));
  it('blocks javascript:', () => blocked('javascript:alert(1)'));
});

// ---------------------------------------------------------------------------
// Credentials (userinfo)
// ---------------------------------------------------------------------------
describe('credentials', () => {
  it('blocks user:pass@host', () => blocked('http://user:pass@example.com/'));
  it('blocks user-only@host', () => blocked('http://user@example.com/'));
  it('blocks :pass@host', () => blocked('http://:pass@example.com/'));
});

// ---------------------------------------------------------------------------
// Blocked hostnames
// ---------------------------------------------------------------------------
describe('blocked hostnames', () => {
  it('blocks localhost', () => blocked('http://localhost/'));
  it('blocks localhost with port', () => blocked('http://localhost:8080/'));
  it('blocks *.local', () => blocked('http://foo.local/'));
  it('blocks deeply nested *.local', () => blocked('http://a.b.local/'));
  it('blocks *.internal', () => blocked('http://bar.internal/'));
  it('blocks *.internal with subdomain', () => blocked('http://api.bar.internal/'));
  it('blocks *.localhost', () => blocked('http://baz.localhost/'));
  it('blocks *.localhost with port', () => blocked('http://app.localhost:3000/'));
});

// ---------------------------------------------------------------------------
// Blocked IPv4 ranges (dotted-decimal)
// ---------------------------------------------------------------------------
describe('blocked IPv4 ranges', () => {
  it('blocks 0.0.0.0/8 — network address', () => blocked('http://0.0.0.1/'));
  it('blocks 0.0.0.0/8 — zero address', () => blocked('http://0.0.0.0/'));
  it('blocks 10.0.0.0/8 — class A private', () => blocked('http://10.0.0.1/'));
  it('blocks 10.255.255.255/8 — class A private upper', () => blocked('http://10.255.255.255/'));
  it('blocks 100.64.0.0/10 — CGNAT lower', () => blocked('http://100.64.0.1/'));
  it('blocks 100.127.255.255/10 — CGNAT upper', () => blocked('http://100.127.255.255/'));
  it('blocks 127.0.0.1/8 — loopback', () => blocked('http://127.0.0.1/'));
  it('blocks 127.255.255.255/8 — loopback upper', () => blocked('http://127.255.255.255/'));
  it('blocks 169.254.0.1/16 — link-local', () => blocked('http://169.254.0.1/'));
  it('blocks 169.254.255.255/16 — link-local upper', () => blocked('http://169.254.255.255/'));
  it('blocks 172.16.0.0/12 — private lower', () => blocked('http://172.16.0.1/'));
  it('blocks 172.31.255.255/12 — private upper', () => blocked('http://172.31.255.255/'));
  it('blocks 192.168.0.1/16 — private', () => blocked('http://192.168.0.1/'));
  it('blocks 192.168.255.255/16 — private upper', () => blocked('http://192.168.255.255/'));
});

// ---------------------------------------------------------------------------
// IPv4 addresses that sit just outside blocked ranges (must be allowed)
// ---------------------------------------------------------------------------
describe('public IPv4 (allowed)', () => {
  it('allows 1.1.1.1 (Cloudflare DNS)', () => allowed('http://1.1.1.1/'));
  it('allows 8.8.8.8 (Google DNS)', () => allowed('http://8.8.8.8/'));
  it('allows 100.63.255.255 — just below CGNAT', () => allowed('http://100.63.255.255/'));
  it('allows 100.128.0.0 — just above CGNAT', () => allowed('http://100.128.0.0/'));
  it('allows 172.15.255.255 — just below 172.16/12', () => allowed('http://172.15.255.255/'));
  it('allows 172.32.0.0 — just above 172.16/12', () => allowed('http://172.32.0.0/'));
});

// ---------------------------------------------------------------------------
// Non-standard IPv4 notation (hex, octal, integer)
// The WHATWG URL parser normalises these to dotted-decimal; guard() must still
// block addresses that fall in private/loopback ranges after normalisation.
// ---------------------------------------------------------------------------
describe('non-standard IPv4 notation', () => {
  // Hex: 0x7f000001 == 127.0.0.1
  it('blocks hex 0x7f000001 (loopback)', () => blocked('http://0x7f000001/'));

  // Octal: 0177.0.0.1 == 127.0.0.1
  it('blocks octal 0177.0.0.1 (loopback)', () => blocked('http://0177.0.0.1/'));

  // Integer: 2130706433 == 127.0.0.1
  it('blocks integer 2130706433 (loopback)', () => blocked('http://2130706433/'));

  // Hex: 0xc0a80001 == 192.168.0.1
  it('blocks hex 0xc0a80001 (192.168.0.1)', () => blocked('http://0xc0a80001/'));

  // Integer: 167772161 == 10.0.0.1
  it('blocks integer 167772161 (10.0.0.1)', () => blocked('http://167772161/'));
});

// ---------------------------------------------------------------------------
// IPv6 — blocked
// ---------------------------------------------------------------------------
describe('blocked IPv6', () => {
  it('blocks ::1 loopback', () => blocked('http://[::1]/'));
  it('blocks fe80::1 link-local', () => blocked('http://[fe80::1]/'));
  it('blocks fe80::1%25eth0 — link-local with zone id (treated as blocked host after strip)', () => {
    // The zone ID is encoded as %25 in a URL; the WHATWG parser keeps it in the
    // hostname.  Guard may reject it as blocked or as an unrecognised form —
    // either way it must NOT be allowed.
    const r = guard('http://[fe80::1%25eth0]/');
    // Accept either ok=false (blocked) or the URL parsing may throw and return ok=false
    expect(r.ok).toBe(false);
  });
  it('blocks fc00::1 ULA', () => blocked('http://[fc00::1]/'));
  it('blocks fd00::1 ULA', () => blocked('http://[fd00::1]/'));
  it('blocks fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff ULA upper', () => blocked('http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/'));
  it('blocks ::ffff:127.0.0.1 IPv4-mapped loopback', () => blocked('http://[::ffff:127.0.0.1]/'));
  it('blocks ::ffff:10.0.0.1 IPv4-mapped private', () => blocked('http://[::ffff:10.0.0.1]/'));
  it('blocks ::ffff:192.168.1.1 IPv4-mapped private', () => blocked('http://[::ffff:192.168.1.1]/'));
});

// ---------------------------------------------------------------------------
// IPv6 — allowed
// ---------------------------------------------------------------------------
describe('public IPv6 (allowed)', () => {
  it('allows 2606:4700::6810:84e5 (Cloudflare)', () => allowed('http://[2606:4700::6810:84e5]/'));
  it('allows 2001:4860:4860::8888 (Google DNS)', () => allowed('http://[2001:4860:4860::8888]/'));
});

// ---------------------------------------------------------------------------
// Valid public domain URLs that must pass
// ---------------------------------------------------------------------------
describe('valid public URLs', () => {
  it('allows https://github.com', () => allowed('https://github.com'));
  it('allows https://example.com/path?q=1#frag', () => allowed('https://example.com/path?q=1#frag'));
  it('allows http://example.com:8080/', () => allowed('http://example.com:8080/'));
  it('allows https://web.archive.org/web/20240101000000*/https://example.com', () =>
    allowed('https://web.archive.org/web/20240101000000*/https://example.com'));
  it('allows https://xn--nxasmq6b.com (IDN punycode)', () => allowed('https://xn--nxasmq6b.com/'));
});
