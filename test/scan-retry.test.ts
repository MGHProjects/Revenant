import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run.js';
import { scan } from '../src/net/scan.js';
import { handleCheckLinks } from '../src/mcp/server.js';
import type { ArchiveAnswer, CliOutput, Fetcher, Probe, ScanEvent, SnapshotResult, Wayback } from '../src/core/types.js';

// Task 18.3: scan() asks once more for the links whose archive answer was unavailable.
// A later `judgement` event for the same URL replaces the earlier one.

const EPITAPH = { first: '2015-01-01', last: '2021-06-15', copy: '2020-06-15' };
const resurrectionOf = (url: string): string => `https://web.archive.org/web/20200615000000/${url}`;
const GOOD: ArchiveAnswer = { epitaph: 'none' };

/** Fake Wayback whose n-th answer for a URL comes from `answers(url, n)` (n starts at 1). */
function fakeWayback(answers: (url: string, n: number) => ArchiveAnswer) {
  const asked = new Map<string, number>();
  const wayback: Wayback = {
    async getArchive(url) {
      const n = (asked.get(url) ?? 0) + 1;
      asked.set(url, n);
      return answers(url, n);
    },
    async getSnapshotText(): Promise<SnapshotResult> {
      return { status: 'none' };
    },
  };
  return { wayback, asked };
}

const found = (url: string): ArchiveAnswer => ({ epitaph: EPITAPH, resurrection: resurrectionOf(url) });

/** Fetcher: 404 for URLs containing "gone", 403 for "blocked", 200 otherwise. Counts calls. */
function fakeFetcher() {
  const calls = new Map<string, number>();
  const fetcher: Fetcher = async (url): Promise<Probe> => {
    calls.set(url, (calls.get(url) ?? 0) + 1);
    if (url.includes('gone')) return { outcome: 'response', status: 404, finalUrl: url, text: '' };
    if (url.includes('blocked')) return { outcome: 'response', status: 403, finalUrl: url, text: '' };
    return { outcome: 'response', status: 200, finalUrl: url, text: '<p>fine</p>' };
  };
  return { fetcher, calls };
}

async function collect(source: string, fetcher: Fetcher, wayback: Wayback): Promise<ScanEvent[]> {
  const events: ScanEvent[] = [];
  for await (const e of scan(source, 'markdown', fetcher, wayback)) events.push(e);
  return events;
}

const judgementsOf = (events: ScanEvent[]) =>
  events.flatMap(e => (e.type === 'judgement' ? [e.judgement] : []));

describe('scan() final retry', () => {
  it('unavailable once, then fine: a second judgement with epitaph and resurrection supersedes the first', async () => {
    const u = 'https://gone-a.example.com/x';
    const { fetcher } = fakeFetcher();
    const { wayback, asked } = fakeWayback((url, n) => (n === 1 ? { epitaph: 'unavailable' } : found(url)));
    const events = await collect(`[a](${u})`, fetcher, wayback);

    expect(events.map(e => e.type)).toEqual(['meta', 'judgement', 'judgement']);
    const [first, second] = judgementsOf(events);
    expect(first!.epitaph).toBe('unavailable');
    expect(first!.archiveUnavailable).toBe(true);
    expect(second!.link.url).toBe(u);
    expect(second!.verdict).toBe('dead');
    expect(second!.epitaph).toEqual(EPITAPH);
    expect(second!.resurrection).toBe(resurrectionOf(u));
    expect(second!.archiveUnavailable).toBeUndefined();
    expect(asked.get(u)).toBe(2);
  });

  it('always unavailable: asked exactly once more, two events, the second still flagged', async () => {
    const u = 'https://gone-b.example.com/x';
    const { fetcher, calls } = fakeFetcher();
    const { wayback, asked } = fakeWayback(() => ({ epitaph: 'unavailable' }));
    const events = await collect(`[a](${u})`, fetcher, wayback);
    expect(judgementsOf(events)).toHaveLength(2);
    expect(asked.get(u)).toBe(2);
    expect(calls.get(u)).toBe(2);
    expect(judgementsOf(events)[1]!.archiveUnavailable).toBe(true);
  });

  it('retries only the flagged links, after the whole first pass', async () => {
    const gone = 'https://gone-c.example.com/x';
    const fine = 'https://fine-c.example.com/x';
    const blocked = 'https://blocked-c.example.com/x';
    const { fetcher, calls } = fakeFetcher();
    const { wayback } = fakeWayback((url, n) => (n === 1 ? { epitaph: 'unavailable' } : found(url)));
    const events = await collect(`[a](${gone}) [b](${fine}) [c](${blocked})`, fetcher, wayback);
    const urls = judgementsOf(events).map(j => j.link.url);
    expect(urls).toHaveLength(4);
    expect(new Set(urls.slice(0, 3))).toEqual(new Set([gone, fine, blocked]));
    expect(urls[3]).toBe(gone);
    expect(calls.get(fine)).toBe(1);
    // A restless link from the site itself (403) is never retried.
    expect(calls.get(blocked)).toBe(1);
    expect(calls.get(gone)).toBe(2);
  });

  it('retries a restless link whose only cause was the archive', async () => {
    const u = 'https://moved-d.example.com/x';
    const calls = { n: 0 };
    const fetcher: Fetcher = async () => {
      calls.n += 1;
      return { outcome: 'response', status: 200, finalUrl: 'https://other-domain.test/', text: '<p>ads</p>' };
    };
    const wayback: Wayback = {
      async getArchive() {
        return GOOD;
      },
      async getSnapshotText() {
        return { status: 'unavailable' };
      },
    };
    const events = await collect(`[a](${u})`, fetcher, wayback);
    expect(judgementsOf(events)).toHaveLength(2);
    expect(judgementsOf(events)[0]!.verdict).toBe('restless');
    expect(calls.n).toBe(2);
  });

  it('sends no retry when nothing was unavailable', async () => {
    const { fetcher } = fakeFetcher();
    const { wayback } = fakeWayback(url => found(url));
    const events = await collect('[a](https://gone-e.example.com/x) [b](https://fine-e.example.com/x)', fetcher, wayback);
    expect(judgementsOf(events)).toHaveLength(2);
  });

  it('MCP check_links returns one judgement per URL, the final one', async () => {
    const u = 'https://gone-f.example.com/x';
    const { fetcher } = fakeFetcher();
    const { wayback } = fakeWayback((url, n) => (n === 1 ? { epitaph: 'unavailable' } : found(url)));
    const result = await handleCheckLinks({ text: `[a](${u})` }, { fetcher, wayback });
    const payload = JSON.parse(result.content[0]!.text) as { judgements: Array<{ resurrection?: string }> };
    expect(payload.judgements).toHaveLength(1);
    expect(payload.judgements[0]!.resurrection).toBe(resurrectionOf(u));
  });
});

describe('CLI with the final retry', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'revenant-retry-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (text: string): string => {
    const file = join(dir, 'doc.md');
    writeFileSync(file, text, 'utf8');
    return file;
  };

  it('--json holds one link per URL with the final judgement', async () => {
    const u = 'https://gone-g.example.com/x';
    const { fetcher } = fakeFetcher();
    const { wayback } = fakeWayback((url, n) => (n === 1 ? { epitaph: 'unavailable' } : found(url)));
    const r = await runCli([write(`[a](${u})`), '--json'], fetcher, wayback);
    const out = JSON.parse(r.stdout) as CliOutput;
    expect(out.links).toHaveLength(1);
    expect(out.links[0]!.resurrection).toBe(resurrectionOf(u));
    expect(out.links[0]!.epitaph).toEqual(EPITAPH);
    expect(out.links[0]!.archiveUnavailable).toBeUndefined();
    expect(r.stderr).toContain('1 link: 0 alive, 1 dead');
  });

  it('--fix patches with the final judgement', async () => {
    const u = 'https://gone-h.example.com/x';
    const { fetcher } = fakeFetcher();
    const { wayback } = fakeWayback((url, n) => (n === 1 ? { epitaph: 'unavailable' } : found(url)));
    const file = write(`See [a](${u}).\n`);
    await runCli([file, '--fix'], fetcher, wayback);
    expect(readFileSync(file, 'utf8')).toContain(resurrectionOf(u));
  });

  it('streaming prints the first line, then the new line marked when the answer changed', async () => {
    const u = 'https://gone-i.example.com/x';
    const { fetcher } = fakeFetcher();
    const { wayback } = fakeWayback((url, n) => (n === 1 ? { epitaph: 'unavailable' } : found(url)));
    const r = await runCli([write(`[a](${u})`)], fetcher, wayback);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[dead\] /);
    expect(lines[0]).not.toContain('[asked again]');
    expect(lines[1]).toContain(resurrectionOf(u));
    expect(lines[1]!.endsWith(' [asked again]')).toBe(true);
  });

  it('streaming prints nothing more when the second answer is the same', async () => {
    const u = 'https://gone-j.example.com/x';
    const { fetcher } = fakeFetcher();
    const { wayback } = fakeWayback(() => ({ epitaph: 'unavailable' }));
    const r = await runCli([write(`[a](${u})`)], fetcher, wayback);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toContain('1 link: 0 alive, 1 dead');
  });

  it('summary and exit code count the final judgement per URL', async () => {
    const u = 'https://gone-k.example.com/x';
    const v = 'https://fine-k.example.com/x';
    const { fetcher } = fakeFetcher();
    const { wayback } = fakeWayback((url, n) => (n === 1 ? { epitaph: 'unavailable' } : found(url)));
    const r = await runCli([write(`[a](${u}) [b](${v})`)], fetcher, wayback);
    expect(r.stderr).toContain('2 links: 1 alive, 1 dead, 0 possessed, 0 restless');
    expect(r.exitCode).toBe(1);
  });

  // Property 19: --json output holds exactly one judgement per URL, and it is the final one
  it('Property 19: --json has one entry per distinct URL, each the final judgement', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('flaky', 'stuck', 'fine', 'site'), { minLength: 1, maxLength: 9 }),
        async kinds => {
          const urls = kinds.map((k, i) => `https://${k === 'site' ? 'blocked' : 'gone'}-${k}-${i}.example.com/p`);
          const { fetcher } = fakeFetcher();
          const { wayback } = fakeWayback((url, n) => {
            if (url.includes('-stuck-')) return { epitaph: 'unavailable' };
            if (url.includes('-flaky-')) return n === 1 ? { epitaph: 'unavailable' } : found(url);
            return found(url);
          });
          const file = write(urls.map(u => `[x](${u})`).join('\n\n'));
          const r = await runCli([file, '--json'], fetcher, wayback);
          const out = JSON.parse(r.stdout) as CliOutput;
          expect(out.links.map(l => l.url)).toEqual(urls);
          for (const l of out.links) {
            if (l.url.includes('-flaky-')) expect(l.resurrection).toBe(resurrectionOf(l.url));
            if (l.url.includes('-stuck-')) expect(l.archiveUnavailable).toBe(true);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
