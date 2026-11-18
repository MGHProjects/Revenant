// Feature: revenant, Property 7: The guard holds

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { guard } from '../src/core/guard.js';

// ---------------------------------------------------------------------------
// Helpers for building URLs from parts
// ---------------------------------------------------------------------------

function buildUrl(scheme: string, userinfo: string, host: string, path: string): string {
  const auth = userinfo ? `${userinfo}@` : '';
  return `${scheme}://${auth}${host}${path}`;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Safe public hostname: at least two labels, letters/digits only, no special suffixes. */
const arbPublicHostname = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/),
    fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/),
    fc.constantFrom('com', 'org', 'net', 'io', 'dev', 'app'),
  )
  .map(([a, b, tld]) => `${a}.${b}.${tld}`);

/** Blocked hostnames: exact "localhost", and *.local, *.internal, *.localhost suffixes. */
const arbBlockedHostname = fc.oneof(
  fc.constant('localhost'),
  fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/).map(label => `${label}.local`),
  fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/).map(label => `${label}.internal`),
  fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/).map(label => `${label}.localhost`),
);

/** Private/loopback IPv4 ranges in dotted-decimal notation. */
const arbPrivateIPv4 = fc.oneof(
  // 10.0.0.0/8
  fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
    .map(([b, c, d]) => `10.${b}.${c}.${d}`),
  // 172.16.0.0/12
  fc.tuple(fc.integer({ min: 16, max: 31 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
    .map(([b, c, d]) => `172.${b}.${c}.${d}`),
  // 192.168.0.0/16
  fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
    .map(([c, d]) => `192.168.${c}.${d}`),
  // 127.0.0.0/8 (loopback)
  fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
    .map(([b, c, d]) => `127.${b}.${c}.${d}`),
  // 169.254.0.0/16 (link-local)
  fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
    .map(([c, d]) => `169.254.${c}.${d}`),
  // 0.0.0.0/8
  fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
    .map(([b, c, d]) => `0.${b}.${c}.${d}`),
  // 100.64.0.0/10 (CGNAT)
  fc.tuple(fc.integer({ min: 64, max: 127 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
    .map(([b, c, d]) => `100.${b}.${c}.${d}`),
);

/** Blocked IPv6 addresses. */
const arbBlockedIPv6 = fc.oneof(
  // loopback
  fc.constant('[::1]'),
  // link-local fe80::/10
  fc.integer({ min: 0x0000, max: 0x03ff })
    .map(low => `[fe${(0x80 | (low >>> 8)).toString(16).padStart(2, '0')}:${(low & 0xff).toString(16).padStart(2, '0')}00::]`),
  // ULA fc00::/7
  fc.integer({ min: 0xfc00, max: 0xfdff })
    .map(g0 => `[${g0.toString(16)}::]`),
  // IPv4-mapped ::ffff: for blocked IPv4 (use 192.168.x.x as representative)
  fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
    .map(([c, d]) => {
      const g6 = (192 << 8) | 168;
      const g7 = (c << 8) | d;
      return `[::ffff:${g6.toString(16)}:${g7.toString(16)}]`;
    }),
);

/** Non-http/https schemes. */
const arbBlockedScheme = fc.constantFrom('ftp', 'file', 'javascript', 'data', 'ws', 'wss', 'mailto', 'ssh');

/** Userinfo (credentials). */
const arbUserinfo = fc.oneof(
  fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/).map(u => `${u}:password`),
  fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/).map(u => `${u}:`),
  fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/),
);

/** A valid public URL — http or https, public hostname, no credentials. */
const arbValidUrl = fc
  .tuple(
    fc.constantFrom('http', 'https'),
    arbPublicHostname,
    fc.constantFrom('/', '/path', '/page.html', ''),
  )
  .map(([scheme, host, path]) => buildUrl(scheme, '', host, path));

/**
 * arbUrl() — produces URLs covering edge cases:
 * - private IPs in all notations
 * - blocked hostnames
 * - non-http schemes
 * - credentials
 * - valid http/https public URLs
 */
export const arbUrl = (): fc.Arbitrary<{ url: string; expectBlocked: boolean }> =>
  fc.oneof(
    // Private/loopback IPv4
    fc.tuple(fc.constantFrom('http', 'https'), arbPrivateIPv4)
      .map(([s, ip]) => ({ url: `${s}://${ip}/`, expectBlocked: true })),

    // Blocked IPv6
    fc.tuple(fc.constantFrom('http', 'https'), arbBlockedIPv6)
      .map(([s, ip]) => ({ url: `${s}://${ip}/`, expectBlocked: true })),

    // Blocked hostnames
    fc.tuple(fc.constantFrom('http', 'https'), arbBlockedHostname)
      .map(([s, host]) => ({ url: `${s}://${host}/`, expectBlocked: true })),

    // Non-http/https schemes with a public host
    fc.tuple(arbBlockedScheme, arbPublicHostname)
      .map(([s, host]) => ({ url: `${s}://${host}/`, expectBlocked: true })),

    // Credentials (userinfo) with http/https and a public host
    fc.tuple(fc.constantFrom('http', 'https'), arbUserinfo, arbPublicHostname)
      .map(([s, creds, host]) => ({ url: buildUrl(s, creds, host, '/'), expectBlocked: true })),

    // Valid public URLs — should pass
    arbValidUrl.map(url => ({ url, expectBlocked: false })),
  );

// ---------------------------------------------------------------------------
// Property 7
// ---------------------------------------------------------------------------

describe('guard — Property 7: The guard holds', () => {
  it('returns ok:false with a non-empty reason for any blocked URL', () => {
    fc.assert(
      fc.property(arbUrl(), ({ url, expectBlocked }) => {
        const result = guard(url);

        if (expectBlocked) {
          if (result.ok) {
            console.error('Expected ok:false for:', url);
          }
          return result.ok === false && result.reason.length > 0;
        } else {
          // Valid public URL: guard must accept it
          if (!result.ok) {
            console.error('Expected ok:true for:', url, 'but got:', result.reason);
          }
          return result.ok === true;
        }
      }),
      { numRuns: 100 },
    );
  });
});
