/**
 * scan-address.ts: the pure part of "a graveyard has an address".
 * Reads `?sample=1`, `?repo=owner/name` and `?url=https://...` and builds the query string a
 * finished scan should leave in the address bar. No DOM, no globals: Vitest runs it as is.
 */

import { guard } from '../src/core/guard.js';

/** Same shape the page and the Worker accept for a GitHub repo: owner/name. */
export const isRepoSlug = (s: string): boolean => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s);

/** Parameters that start a scan. Every other parameter is left alone. */
const SCAN_PARAMS = ['sample', 'repo', 'url'] as const;

export type ScanParam =
  | { kind: 'none' }
  | { kind: 'sample' }
  | { kind: 'repo'; value: string }
  | { kind: 'url'; value: string }
  | { kind: 'invalid'; message: string };

/** Where a scan's text came from. `text` is the textarea: a pasted document or the loaded sample. */
export type ScanOrigin =
  | { kind: 'sample' }
  | { kind: 'address'; address: string }
  | { kind: 'text' };

/** http(s) only, no credentials, and the same host rules as the Worker (core guard). */
export function validPageUrl(value: string): { ok: true } | { ok: false; reason: string } {
  return guard(value);
}

/** Precedence is sample > repo > url: the first one present wins and the rest are ignored. */
export function parseScanParams(search: string): ScanParam {
  const params = new URLSearchParams(search);
  if (params.get('sample') === '1') return { kind: 'sample' };

  const repo = params.get('repo');
  if (repo !== null) {
    const value = repo.trim();
    return isRepoSlug(value)
      ? { kind: 'repo', value }
      : { kind: 'invalid', message: 'The repo in this link is not valid. Use owner/repo.' };
  }

  const url = params.get('url');
  if (url !== null) {
    const value = url.trim();
    const verdict = validPageUrl(value);
    return verdict.ok
      ? { kind: 'url', value }
      : { kind: 'invalid', message: 'The page address in this link is not valid. Use an http or https address without a password.' };
  }
  return { kind: 'none' };
}

/**
 * The query string after a scan: scan parameters are replaced by the one that describes this
 * scan, unrelated parameters are kept. A textarea scan never writes the document. `shareable`
 * is true when the result has an address a visitor can open again.
 */
export function searchAfterScan(
  currentSearch: string,
  origin: ScanOrigin,
): { search: string; shareable: boolean } {
  const params = new URLSearchParams(currentSearch);
  const had = SCAN_PARAMS.some(k => params.has(k));

  let write: [string, string] | undefined;
  if (origin.kind === 'sample') write = ['sample', '1'];
  else if (origin.kind === 'address') {
    const address = origin.address.trim();
    if (isRepoSlug(address)) write = ['repo', address];
    else if (validPageUrl(address).ok) write = ['url', address];
    else {
      // not something a link can carry: leave the address bar as it is
      return { search: currentSearch, shareable: false };
    }
  }

  if (!write && !had) return { search: currentSearch, shareable: false };
  for (const k of SCAN_PARAMS) params.delete(k);
  if (write) params.set(write[0], write[1]);
  const out = params.toString();
  return { search: out ? `?${out}` : '', shareable: write !== undefined };
}
