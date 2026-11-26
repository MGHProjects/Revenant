import { describe, expect, it } from 'vitest';
import { GITHUB_FILE_MODE, githubFileUrl, isSafeRepoPath } from '../web/github-file.ts';

describe('githubFileUrl', () => {
  it('opens the file at HEAD in the mode named by GITHUB_FILE_MODE', () => {
    expect(GITHUB_FILE_MODE).toBe('blob');
    expect(githubFileUrl('MGHProjects', 'Revenant', 'README.md')).toBe(
      'https://github.com/MGHProjects/Revenant/blob/HEAD/README.md',
    );
  });

  it('keeps subdirectories as separate segments', () => {
    expect(githubFileUrl('o', 'r', 'docs/README.md')).toBe('https://github.com/o/r/blob/HEAD/docs/README.md');
  });

  it('encodes each segment: spaces, ?, #, %, non-ASCII', () => {
    expect(githubFileUrl('o', 'r', 'my docs/Read Me.md')).toBe('https://github.com/o/r/blob/HEAD/my%20docs/Read%20Me.md');
    expect(githubFileUrl('o', 'r', 'a?b#c%d/é.md')).toBe('https://github.com/o/r/blob/HEAD/a%3Fb%23c%25d/%C3%A9.md');
  });

  it('refuses a path that could leave the repo or change the host', () => {
    for (const bad of ['', '/etc/passwd', '../x', 'a/../x', 'a//b', './x', 'a\\b', '//evil.example/x', 'a\nb', 'javascript:alert(1)//']) {
      const url = githubFileUrl('o', 'r', bad);
      // javascript:alert(1)// is a path segment "javascript:alert(1)" plus an empty one: refused
      expect(url, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('a path that looks like a scheme stays inside the github.com path once encoded', () => {
    const url = githubFileUrl('o', 'r', 'javascript:alert(1)');
    expect(url).toBe('https://github.com/o/r/blob/HEAD/javascript%3Aalert(1)');
    expect(new URL(url!).hostname).toBe('github.com');
    expect(new URL(url!).protocol).toBe('https:');
  });

  it('refuses an owner or repo that is not a valid slug', () => {
    expect(githubFileUrl('o/x', 'r', 'README.md')).toBeUndefined();
    expect(githubFileUrl('o', 'r s', 'README.md')).toBeUndefined();
    expect(githubFileUrl('..', 'r', 'README.md')).toBeUndefined();
    expect(githubFileUrl('o', '.', 'README.md')).toBeUndefined();
    expect(githubFileUrl('', 'r', 'README.md')).toBeUndefined();
  });
});

describe('isSafeRepoPath', () => {
  it('accepts plain relative paths', () => {
    expect(isSafeRepoPath('README')).toBe(true);
    expect(isSafeRepoPath('docs/en/README.md')).toBe(true);
  });
});
