/**
 * similarity(a, b) — Jaccard index over 3-word shingles.
 *
 * Returns a value in [0, 1]. Returns 0 when either string is empty (no
 * shingles can be formed). Symmetric: similarity(a, b) === similarity(b, a).
 *
 * In the Worker context this function is called with inputs already capped to
 * the first 64 KB of visible text.
 * // shortcut: fixed 64 KB cap, raise it if the Worker is moved to the paid plan.
 */

/** Split text into an array of lowercase word tokens. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/\w+/g) ?? [];
}

/** Build the set of 3-word shingles from a token array. */
function shingles(tokens: string[]): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i <= tokens.length - 3; i++) {
    result.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  return result;
}

export function similarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;

  const setA = shingles(tokenize(a));
  const setB = shingles(tokenize(b));

  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const s of setA) {
    if (setB.has(s)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return intersection / union;
}
