import type { Judgement } from './types.js';

/**
 * Builds a patched copy of `source` by replacing URL spans for `dead` or
 * `possessed` links that have a `resurrection` and are not in `excluded`.
 *
 * All other bytes are copied verbatim (Requirements 4.1–4.5).
 *
 * Algorithm:
 *  1. Collect (start, end, resurrection) triples from qualifying judgements.
 *  2. Sort by `start` descending.
 *  3. Apply substitutions right-to-left so earlier offsets stay valid.
 */
export function patch(
  source: string,
  judgements: Judgement[],
  excluded: Set<string>,
): string {
  // Step 1: collect replacement entries.
  interface Entry {
    start: number;
    end: number;
    resurrection: string;
  }

  const entries: Entry[] = [];

  for (const judgement of judgements) {
    // Only dead/possessed with a resurrection, not excluded.
    if (judgement.verdict !== 'dead' && judgement.verdict !== 'possessed') continue;
    if (judgement.resurrection === undefined) continue;
    if (excluded.has(judgement.link.url)) continue;

    for (const span of judgement.link.spans) {
      entries.push({ start: span.start, end: span.end, resurrection: judgement.resurrection });
    }
  }

  // Step 2: sort by start descending (right-to-left application order).
  entries.sort((a, b) => b.start - a.start);

  // Step 3: apply substitutions.
  let result = source;
  for (const { start, end, resurrection } of entries) {
    result = result.slice(0, start) + resurrection + result.slice(end);
  }

  return result;
}
