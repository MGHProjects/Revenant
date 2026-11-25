/**
 * host-parts.ts: splits a host into the pieces a plot label may break between.
 * Pure, no DOM, so Vitest can test it.
 */

/** "a.b.com" -> ["a.", "b.", "com"]. Each dot stays with the part before it; join('') is the host. */
export function hostParts(host: string): string[] {
  return host.match(/[^.]*\.|[^.]+$/g) ?? [];
}
