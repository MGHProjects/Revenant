import type { Judgement } from './types.js';

export const NEVER_ARCHIVED = 'Lost: never archived';
export const ARCHIVE_UNREACHABLE = 'The archive could not be reached. Try again.';

/**
 * The sentence every door shows for a dead or possessed link with no resurrection.
 * Undefined when there is nothing to say (alive/restless, a snapshot exists, or no archive lookup was made).
 */
export function archiveNote(j: Pick<Judgement, 'verdict' | 'epitaph' | 'resurrection'>): string | undefined {
  if (j.verdict !== 'dead' && j.verdict !== 'possessed') return undefined;
  if (j.resurrection !== undefined) return undefined;
  if (j.epitaph === 'none') return NEVER_ARCHIVED;
  if (j.epitaph === 'unavailable') return ARCHIVE_UNREACHABLE;
  return undefined;
}
