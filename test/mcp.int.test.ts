/**
 * MCP server integration tests — test/mcp.int.test.ts
 *
 * Handlers are called directly with fake Fetcher and Wayback.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4
 */

import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createMcpServer,
  handleCheckLinks,
  handleResurrect,
  type McpDeps,
} from '../src/mcp/index.js';
import type { ClosestSnapshot, Fetcher, Probe, Wayback } from '../src/core/types.js';

const URL_ALIVE = 'https://alive.example.com/page';
const URL_DEAD = 'https://dead.example.com/page';
const SNAP = 'https://web.archive.org/web/20210615000000/https://dead.example.com/page';

const fetcher: Fetcher = async (url: string): Promise<Probe> => {
  if (url === URL_DEAD) return { outcome: 'response', status: 404, finalUrl: url, text: '' };
  if (url === URL_ALIVE) return { outcome: 'response', status: 200, finalUrl: url, text: 'hello' };
  return { outcome: 'network-error', text: `unexpected ${url}` };
};

function makeWayback(closest?: ClosestSnapshot): Wayback & { calls: Array<[string, string | undefined]> } {
  const calls: Array<[string, string | undefined]> = [];
  return {
    calls,
    async getEpitaph() {
      return { first: '2015-01-01', last: '2021-06-15' };
    },
    async getResurrection(url: string) {
      return url === URL_DEAD ? SNAP : undefined;
    },
    async getSnapshotText() {
      return undefined;
    },
    ...(closest
      ? {
          async getClosestSnapshot(url: string, date?: string) {
            calls.push([url, date]);
            return closest;
          },
        }
      : {}),
  };
}

function deps(closest?: ClosestSnapshot): McpDeps {
  return { fetcher, wayback: makeWayback(closest) };
}

function payload(r: { content: Array<{ text: string }> }): any {
  return JSON.parse(r.content[0]!.text);
}

describe('check_links', () => {
  it('checks links found in text', async () => {
    const r = await handleCheckLinks({ text: `[a](${URL_ALIVE}) and [b](${URL_DEAD})` }, deps());
    expect(r.isError).toBeUndefined();
    const p = payload(r);
    expect(p.total).toBe(2);
    expect(p.capped).toBe(false);
    const byUrl = Object.fromEntries(p.judgements.map((j: any) => [j.link.url, j]));
    expect(byUrl[URL_ALIVE].verdict).toBe('alive');
    expect(byUrl[URL_DEAD].verdict).toBe('dead');
    expect(byUrl[URL_DEAD].resurrection).toBe(SNAP);
    expect(byUrl[URL_DEAD].epitaph).toEqual({ first: '2015-01-01', last: '2021-06-15' });
  });

  it('checks a list of urls', async () => {
    const r = await handleCheckLinks({ urls: [URL_ALIVE, URL_DEAD] }, deps());
    expect(r.isError).toBeUndefined();
    const p = payload(r);
    expect(p.judgements.map((j: any) => j.verdict).sort()).toEqual(['alive', 'dead']);
  });

  it('returns an MCP error for empty input', async () => {
    for (const args of [{}, { text: '' }, { text: '   ' }, { urls: [] }]) {
      const r = await handleCheckLinks(args, deps());
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe('no URLs found');
    }
  });

  it('returns an MCP error when text contains no URLs', async () => {
    const r = await handleCheckLinks({ text: 'just some prose, no links here' }, deps());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/no URLs found/);
  });

  it('reports a guard-rejected URL as restless with the rejection reason', async () => {
    let fetched = false;
    const spy: Fetcher = async () => {
      fetched = true;
      return { outcome: 'network-error' };
    };
    const r = await handleCheckLinks(
      { text: '[x](http://127.0.0.1/)' },
      { fetcher: spy, wayback: makeWayback() },
    );
    expect(r.isError).toBeUndefined();
    const j = payload(r).judgements[0];
    expect(j.verdict).toBe('restless');
    expect(typeof j.reason).toBe('string');
    expect(j.reason.length).toBeGreaterThan(0);
    expect(fetched).toBe(false);
  });
});

describe('resurrect', () => {
  const D = { url: URL_DEAD };

  it('returns the snapshot when found', async () => {
    const r = await handleResurrect(D, deps({ status: 'found', url: SNAP, date: '2021-06-15' }));
    expect(r.isError).toBeUndefined();
    expect(payload(r)).toMatchObject({ found: true, snapshotUrl: SNAP, snapshotDate: '2021-06-15' });
  });

  it('reports lost with no invented URL when no snapshot exists', async () => {
    const p = payload(await handleResurrect(D, deps({ status: 'none' })));
    expect(p.found).toBe(false);
    expect(p.lost).toBe(true);
    expect(p.archiveAvailability).toBe('known');
    expect(p.snapshotUrl).toBeUndefined();
  });

  it('reports unknown availability when Wayback is unreachable', async () => {
    const p = payload(await handleResurrect(D, deps({ status: 'unreachable' })));
    expect(p.found).toBe(false);
    expect(p.archiveAvailability).toBe('unknown');
    expect(p.snapshotUrl).toBeUndefined();
  });

  it('reports lost and unknown when the fallback path sees an unreachable archive', async () => {
    const wayback: Wayback = {
      async getEpitaph() {
        return 'unavailable';
      },
      async getResurrection() {
        return undefined;
      },
      async getSnapshotText() {
        return undefined;
      },
    };
    const p = payload(await handleResurrect(D, { fetcher, wayback }));
    expect(p).toMatchObject({ found: false, lost: true, archiveAvailability: 'unknown' });
    expect(p.snapshotUrl).toBeUndefined();
  });

  it('passes the date to the Wayback lookup', async () => {
    const wb = makeWayback({ status: 'found', url: SNAP, date: '2019-03-01' });
    const r = await handleResurrect({ url: URL_DEAD, date: '2019-03-01' }, { fetcher, wayback: wb });
    expect(payload(r).found).toBe(true);
    expect(wb.calls).toEqual([[URL_DEAD, '2019-03-01']]);
  });

  it('rejects a malformed date and a missing url', async () => {
    expect((await handleResurrect({ url: URL_DEAD, date: 'June 2019' }, deps())).isError).toBe(true);
    expect((await handleResurrect({}, deps())).isError).toBe(true);
  });
});

describe('createMcpServer', () => {
  it('lists check_links and resurrect over an in-memory transport', async () => {
    const server = createMcpServer(deps());
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['check_links', 'resurrect']);
    await client.close();
    await server.close();
  });
});
