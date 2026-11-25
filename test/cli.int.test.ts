/**
 * CLI integration tests — test/cli.int.test.ts
 *
 * Tests the runCli() exported function using fake Fetcher and Wayback
 * and a temporary file on disk (for --fix tests).
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../src/cli/index.js';
import type { Fetcher, Probe, SnapshotResult, Wayback, Epitaph, CliOutput } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Test URLs
// ---------------------------------------------------------------------------

const URL_DEAD      = 'https://dead.example.com/page';
const URL_POSSESSED = 'https://possessed.example.com/page';
const URL_RESTLESS  = 'https://restless.example.com/page';
const URL_ALIVE     = 'https://alive.example.com/page';

// ---------------------------------------------------------------------------
// Fake Wayback
// ---------------------------------------------------------------------------

const EPITAPH: Epitaph = { first: '2015-01-01', last: '2021-06-15' };
const RESURRECTION_URL_DEAD = 'https://web.archive.org/web/20210615000000/https://dead.example.com/page';
const RESURRECTION_URL_POSSESSED = 'https://web.archive.org/web/20210615000000/https://possessed.example.com/page';

const SNAPSHOT_TEXT_POSSESSED =
  'ancient original words about revenant project history documentation';
const LIVE_TEXT_POSSESSED =
  'buy now discount casino poker gambling slots promotion special offer';

const fakeWayback: Wayback = {
  async getEpitaph(_url: string): Promise<Epitaph | 'unavailable'> {
    return EPITAPH;
  },
  async getResurrection(url: string): Promise<string | undefined> {
    if (url === URL_DEAD) return RESURRECTION_URL_DEAD;
    if (url === URL_POSSESSED) return RESURRECTION_URL_POSSESSED;
    return undefined;
  },
  async getSnapshotText(url: string): Promise<SnapshotResult> {
    if (url === URL_POSSESSED) return { status: 'text', text: SNAPSHOT_TEXT_POSSESSED };
    return { status: 'none' };
  },
};

// ---------------------------------------------------------------------------
// Fake Fetcher
// ---------------------------------------------------------------------------

const fakeFetcher: Fetcher = async (url: string): Promise<Probe> => {
  switch (url) {
    case URL_DEAD:
      return { outcome: 'response', status: 404, finalUrl: url, text: '' };
    case URL_POSSESSED:
      return {
        outcome: 'response',
        status: 200,
        finalUrl: 'https://hijacked-domain.net/ads',
        text: LIVE_TEXT_POSSESSED,
      };
    case URL_RESTLESS:
      return { outcome: 'response', status: 403, finalUrl: url, text: '' };
    case URL_ALIVE:
      return { outcome: 'response', status: 200, finalUrl: url, text: 'good content' };
    default:
      return { outcome: 'network-error', text: `unexpected url: ${url}` };
  }
};

// ---------------------------------------------------------------------------
// Fake Fetcher — all alive
// ---------------------------------------------------------------------------

const allAliveFetcher: Fetcher = async (url: string): Promise<Probe> => {
  return { outcome: 'response', status: 200, finalUrl: url, text: 'alive content' };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Markdown document with four links: dead, possessed, restless, alive. */
const MIXED_DOCUMENT = [
  `# Test`,
  ``,
  `- [Dead](${URL_DEAD})`,
  `- [Possessed](${URL_POSSESSED})`,
  `- [Restless](${URL_RESTLESS})`,
  `- [Alive](${URL_ALIVE})`,
].join('\n');

/** Markdown document with only alive links. */
const ALL_ALIVE_DOCUMENT = [
  `# Test`,
  ``,
  `- [Alive](${URL_ALIVE})`,
].join('\n');

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'revenant-cli-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmpFile(name: string, content: string): string {
  const p = join(tmpDir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLI default output with mixed verdicts', () => {
  it('prints one line per non-alive link, exit 1 (Requirements 7.1, 7.2, 7.3)', async () => {
    const filePath = writeTmpFile('mixed.md', MIXED_DOCUMENT);
    const { exitCode, stdout, stderr } = await runCli([filePath], fakeFetcher, fakeWayback);

    // Exit 1 because there are dead and possessed links.
    expect(exitCode).toBe(1);

    // Dead link appears in output.
    expect(stdout).toContain(URL_DEAD);
    expect(stdout).toContain('[dead]');

    // Possessed link appears in output.
    expect(stdout).toContain(URL_POSSESSED);
    expect(stdout).toContain('[possessed]');

    // Restless link appears in output (non-alive).
    expect(stdout).toContain(URL_RESTLESS);
    expect(stdout).toContain('[restless]');

    // Alive link does NOT appear in default output.
    expect(stdout).not.toContain(URL_ALIVE);

    // stderr should be empty for a normal run.
    expect(stderr).toBe('');
  });

  it('each output line has format: [verdict] url — reason (resurrection)', async () => {
    const filePath = writeTmpFile('mixed.md', MIXED_DOCUMENT);
    const { stdout } = await runCli([filePath], fakeFetcher, fakeWayback);

    const lines = stdout.split('\n').filter(Boolean);
    // Each line should start with [verdict].
    for (const line of lines) {
      expect(line).toMatch(/^\[(dead|possessed|restless|alive)\]/);
    }

    // Dead link line should contain resurrection URL.
    const deadLine = lines.find(l => l.includes(URL_DEAD));
    expect(deadLine).toBeDefined();
    expect(deadLine).toContain(RESURRECTION_URL_DEAD);
  });
});

describe('CLI all-alive: no output, exit 0', () => {
  it('prints nothing to stdout and exits 0 when all links are alive (Requirement 7.3)', async () => {
    const filePath = writeTmpFile('alive.md', ALL_ALIVE_DOCUMENT);
    const { exitCode, stdout, stderr } = await runCli([filePath], allAliveFetcher, fakeWayback);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });
});

describe('CLI exit codes', () => {
  it('exits 1 when document has dead links (Requirement 7.3)', async () => {
    const doc = `- [Dead](${URL_DEAD})`;
    const filePath = writeTmpFile('dead.md', doc);
    const { exitCode } = await runCli([filePath], fakeFetcher, fakeWayback);
    expect(exitCode).toBe(1);
  });

  it('exits 1 when document has possessed links (Requirement 7.3)', async () => {
    const doc = `- [Possessed](${URL_POSSESSED})`;
    const filePath = writeTmpFile('possessed.md', doc);
    const { exitCode } = await runCli([filePath], fakeFetcher, fakeWayback);
    expect(exitCode).toBe(1);
  });

  it('exits 0 when document has only restless links (Requirement 7.3)', async () => {
    const doc = `- [Restless](${URL_RESTLESS})`;
    const filePath = writeTmpFile('restless.md', doc);
    const { exitCode } = await runCli([filePath], fakeFetcher, fakeWayback);
    expect(exitCode).toBe(0);
  });
});

describe('CLI --fix rewrites file', () => {
  it('replaces dead and possessed URLs in file with resurrection URLs (Requirement 7.4)', async () => {
    const filePath = writeTmpFile('fix.md', MIXED_DOCUMENT);

    const { exitCode, stdout, stderr } = await runCli(
      [filePath, '--fix'],
      fakeFetcher,
      fakeWayback,
    );

    // --fix always exits with the standard code but here dead/possessed exist.
    expect(exitCode).toBe(1);

    // No per-line stdout output when --fix is active.
    expect(stdout).toBe('');

    // Stderr reports how many links were patched.
    expect(stderr).toContain('Patched');
    expect(stderr).toContain(filePath);

    // File should now contain resurrection URLs in the link targets.
    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain(`](${RESURRECTION_URL_DEAD})`);
    expect(content).toContain(`](${RESURRECTION_URL_POSSESSED})`);
    // The original bare URLs should no longer appear as markdown link targets.
    expect(content).not.toContain(`](${URL_DEAD})`);
    expect(content).not.toContain(`](${URL_POSSESSED})`);

    // Alive and restless URLs should be unchanged.
    expect(content).toContain(URL_ALIVE);
    expect(content).toContain(URL_RESTLESS);
  });

  it('--fix replaces possessed links as well as dead links (Requirement 7.4)', async () => {
    const doc = `- [Possessed](${URL_POSSESSED})`;
    const filePath = writeTmpFile('possessed-fix.md', doc);

    await runCli([filePath, '--fix'], fakeFetcher, fakeWayback);

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain(`](${RESURRECTION_URL_POSSESSED})`);
    expect(content).not.toContain(`](${URL_POSSESSED})`);
  });
});

describe('CLI --fix on URL input', () => {
  it('prints error to stderr and exits 2 (Requirement 7.5)', async () => {
    const { exitCode, stdout, stderr } = await runCli(
      ['https://example.com/', '--fix'],
      fakeFetcher,
      fakeWayback,
    );

    expect(exitCode).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('--fix requires a file path');
  });
});

describe('CLI --json output', () => {
  it('prints valid CliOutput JSON to stdout (Requirement 7.6)', async () => {
    const filePath = writeTmpFile('json.md', MIXED_DOCUMENT);
    const { exitCode, stdout } = await runCli([filePath, '--json'], fakeFetcher, fakeWayback);

    // Exit code should still be 1 (dead/possessed present).
    expect(exitCode).toBe(1);

    // stdout is valid JSON.
    let parsed: CliOutput;
    expect(() => { parsed = JSON.parse(stdout); }).not.toThrow();

    // Has a `links` array.
    expect(parsed!).toHaveProperty('links');
    expect(Array.isArray(parsed!.links)).toBe(true);

    // All four URLs are present.
    const urls = parsed!.links.map(l => l.url);
    expect(urls).toContain(URL_DEAD);
    expect(urls).toContain(URL_POSSESSED);
    expect(urls).toContain(URL_RESTLESS);
    expect(urls).toContain(URL_ALIVE);

    // Each entry has required fields.
    for (const entry of parsed!.links) {
      expect(entry).toHaveProperty('url');
      expect(entry).toHaveProperty('verdict');
      expect(entry).toHaveProperty('reason');
      expect(entry).toHaveProperty('spans');
      expect(Array.isArray(entry.spans)).toBe(true);
    }

    // Dead link has resurrection in JSON.
    const deadEntry = parsed!.links.find(l => l.url === URL_DEAD);
    expect(deadEntry).toBeDefined();
    expect(deadEntry!.resurrection).toBe(RESURRECTION_URL_DEAD);
  });

  it('--json output contains verdicts for all links including alive (Requirement 7.6)', async () => {
    const filePath = writeTmpFile('json-alive.md', ALL_ALIVE_DOCUMENT);
    const { exitCode, stdout } = await runCli([filePath, '--json'], allAliveFetcher, fakeWayback);

    expect(exitCode).toBe(0);

    const parsed: CliOutput = JSON.parse(stdout);
    expect(parsed.links.length).toBeGreaterThan(0);
    expect(parsed.links[0]?.verdict).toBe('alive');
  });
});

describe('CLI --fix --json on URL input', () => {
  it('writes JSON error to stderr and exits 2 (Requirement 7.5, 7.6)', async () => {
    const { exitCode, stdout, stderr } = await runCli(
      ['https://example.com/', '--fix', '--json'],
      fakeFetcher,
      fakeWayback,
    );

    expect(exitCode).toBe(2);
    expect(stdout).toBe('');

    // stderr should be valid JSON with an `error` field.
    let parsed: { error: string };
    expect(() => { parsed = JSON.parse(stderr.trim()); }).not.toThrow();
    expect(parsed!).toHaveProperty('error');
    expect(parsed!.error).toContain('--fix requires a file path');
  });
});

describe('CLI missing input argument', () => {
  it('prints usage to stderr and exits 2', async () => {
    const { exitCode, stdout, stderr } = await runCli([], fakeFetcher, fakeWayback);

    expect(exitCode).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('Usage:');
  });
});

// ---------------------------------------------------------------------------
// Archive notes in default output
// ---------------------------------------------------------------------------

describe('runCli — archive notes', () => {
  it('prints the never-archived and unreachable sentences for dead links', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'revenant-note-'));
    try {
      const file = join(dir, 'notes.md');
      writeFileSync(file, '[a](https://never.example.com/)\n[b](https://silent.example.com/)\n', 'utf8');
      const deadFetcher: Fetcher = async (url: string): Promise<Probe> => ({
        outcome: 'response',
        status: 404,
        finalUrl: url,
        text: '',
      });
      const wayback: Wayback = {
        async getEpitaph(url: string) {
          return url.includes('never') ? 'none' : 'unavailable';
        },
        async getResurrection() {
          return undefined;
        },
        async getSnapshotText() {
          return { status: 'none' };
        },
      };
      const { stdout } = await runCli([file], deadFetcher, wayback);
      const lines = stdout.trim().split('\n');
      const never = lines.find(l => l.includes('never.example.com'))!;
      const silent = lines.find(l => l.includes('silent.example.com'))!;
      expect(never).toContain('(Lost: never archived)');
      expect(silent).toContain('(The archive could not be reached. Try again.)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
