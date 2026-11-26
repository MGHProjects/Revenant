/**
 * fix-steps.ts: the words of the "from verdict to fix" area. Pure: no DOM, no globals.
 */

import { patch } from '../src/core/patch.js';
import type { Judgement } from '../src/core/types.js';

const links = (n: number): string => (n === 1 ? 'link' : 'links');

/**
 * The patched text. Copy and Download both call this, so they cannot differ.
 * Undefined entries (links whose batch failed) are skipped.
 */
export function patchedDocument(
  source: string,
  judgements: ReadonlyArray<Judgement | undefined>,
  excluded: Set<string>,
): string {
  return patch(source, judgements.filter((j): j is Judgement => j !== undefined), excluded);
}

/** The steps beside the buttons. `githubLink` is true when the scan came from a repo whose file is known. */
export function fixSteps(githubLink: boolean): string[] {
  return githubLink
    ? ['Copy the patched document.', 'Open the README on GitHub.', 'Paste it and propose the change.']
    : ['Copy or download the patched document.', 'Replace the original with it.'];
}

export const openOnGithubLabel = (file: string): string => `Open ${file} on GitHub`;

export const copiedMessage = (n: number): string => `Patched document copied: ${n} ${links(n)} changed.`;

export const COPY_FAILED_MESSAGE = 'Could not copy. The patched document is selected below: press Ctrl+C.';
