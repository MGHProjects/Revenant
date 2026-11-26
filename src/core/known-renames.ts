/**
 * Known renames: registrable domains whose owner moved the whole service to another
 * registrable domain with a different name. The old domain redirecting to the new one is a
 * move, never a possession. Keys and values are registrable domains (see domain.ts), so a
 * subdomain such as mobile.twitter.com matches through its registrable domain.
 *
 * Keep this list short. Each entry needs a comment saying what moved and why it is safe to
 * call the redirect legitimate. A rename whose name label is the same (exercism.io to
 * exercism.org) needs no entry; redirect-kind.ts handles that by rule.
 *
 * Pure data, no globals.
 */
export const KNOWN_RENAMES: ReadonlyMap<string, string> = new Map([
  // Twitter was rebranded to X in July 2023 and twitter.com redirects to x.com, same service,
  // same owner, same paths (twitter.com/u/status/1 becomes x.com/u/status/1).
  ['twitter.com', 'x.com'],
  // Repl.it rebranded to Replit (the name lost its dot, the domain changed from repl.it to
  // replit.com). Same company and product; repl.it redirects to replit.com. Found in the
  // every-programmer-should-know field test (26 Nov 2026).
  ['repl.it', 'replit.com'],
]);
