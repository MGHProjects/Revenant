/**
 * redirectKind(originalUrl, finalUrl) — what kind of move a redirect is, from the two URLs alone.
 *
 *   'same-site'  same registrable domain (or no usable final domain): nothing to judge.
 *   'moved'      a known rename (known-renames.ts) or the same name under another public suffix
 *                (exercism.io to exercism.org, foo.co.uk to foo.com). The same site, alive.
 *   'other'      a different registrable domain: the archive comparison decides.
 *
 * It needs no snapshot, so judgeLink calls it first and skips the Wayback calls for 'moved'.
 * Blind spot, on purpose: a squatter owning foo.net after foo.com was cited is 'moved'.
 *
 * Pure — no fetch, no globals.
 */

import { registrableDomain } from './domain.ts';
import { KNOWN_RENAMES } from './known-renames.ts';

export type RedirectKind = 'same-site' | 'moved' | 'other';

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** The label to the left of the public suffix: exercism.org → exercism, foo.co.uk → foo. */
export function nameLabel(registrable: string): string {
  return registrable.split('.')[0] ?? '';
}

export function redirectKind(originalUrl: string, finalUrl: string): RedirectKind {
  const orig = registrableDomain(hostnameOf(originalUrl));
  const final = registrableDomain(hostnameOf(finalUrl));
  if (final === '' || orig === final) return 'same-site';
  if (KNOWN_RENAMES.get(orig) === final) return 'moved';
  const name = nameLabel(orig);
  if (name !== '' && name === nameLabel(final)) return 'moved';
  return 'other';
}
