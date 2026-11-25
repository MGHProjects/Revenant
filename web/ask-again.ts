/**
 * ask-again.ts: the pure parts of "Ask again" and the automatic retry. No DOM, so Vitest imports it.
 *
 * Requirements: 3, 6
 */

import type { Judgement, Verdict } from '../src/core/types.js';

/** A restless link can always be asked again; a dead or possessed one only when the archive failed. */
export function canAskAgain(v: { verdict: Verdict; archiveUnavailable?: true | undefined }): boolean {
  return v.verdict === 'restless' || v.archiveUnavailable === true;
}

/** Document positions the automatic retry asks about: exactly the links flagged archiveUnavailable. */
export function retryIndexes(judgements: ReadonlyArray<Judgement | undefined>): number[] {
  const out: number[] = [];
  judgements.forEach((j, i) => {
    if (j?.archiveUnavailable === true) out.push(i);
  });
  return out;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Replace the judgement at `index` with a fresh answer. Same length and order; the link (with its
 * spans) stays the original. The Patch choice lives in `excluded`, keyed by URL, and is returned
 * unchanged: a link the user unchecked stays unchecked, a link with no earlier choice is checked.
 */
export function mergeJudgement(
  judgements: ReadonlyArray<Judgement | undefined>,
  index: number,
  fresh: Judgement,
  excluded: ReadonlySet<string>,
): { judgements: Array<Judgement | undefined>; excluded: Set<string> } {
  const old = judgements[index];
  const next = judgements.slice();
  if (old) next[index] = { ...fresh, link: old.link };
  return { judgements: next, excluded: new Set(excluded) };
}