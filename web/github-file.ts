/**
 * github-file.ts: where "Open {file} on GitHub" points. Pure: no DOM, no globals.
 *
 * Anonymous check (curl, 2026): /edit/HEAD/README.md, /edit/main/README.md and
 * /edit/no-such-branch-xyz/README.md all answer 302 to github.com/login?return_to=<same path>,
 * so HEAD cannot be told apart from a branch that does not exist without being logged in.
 * /blob/HEAD/README.md answers 200. Until the edit form is checked in a logged-in browser,
 * the link opens the file view. To switch to the edit form, change GITHUB_FILE_MODE to 'edit'.
 */

import { isRepoSlug } from './scan-address.js';

export const GITHUB_FILE_MODE: 'blob' | 'edit' = 'blob';

/** A relative repo path: no empty, `.` or `..` segments, no backslash, no control characters. */
export function isSafeRepoPath(file: string): boolean {
  if (file === '' || file.startsWith('/') || file.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(file)) return false;
  return file.split('/').every(s => s !== '' && s !== '.' && s !== '..');
}

/** The GitHub URL for a file of a repo, or undefined when owner/repo or the path is not safe. */
export function githubFileUrl(owner: string, repo: string, file: string): string | undefined {
  const bad = (s: string): boolean => s === '.' || s === '..';
  if (!isRepoSlug(`${owner}/${repo}`) || bad(owner) || bad(repo) || !isSafeRepoPath(file)) return undefined;
  const path = file.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${owner}/${repo}/${GITHUB_FILE_MODE}/HEAD/${path}`;
}
