import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { judgeLink } from '../src/net/judge-link.js';
import { createWaybackClient } from '../src/net/wayback.js';
import type { Fetcher, Judgement, Link, Probe } from '../src/core/types.js';

// Task 15.13: one CDX answer yields the epitaph and the resurrection, or neither.

afterEach(() => {
  vi.unstubAllGlobals();
});

const CDX_OK = JSON.stringify([
  ['timestamp', 'length'],
  ['20120101000000', '5000'],
  ['20120201000000', '5000'],
  ['20120301000000', '5000'],
]);

const noSleep = async (): Promise<void> => {};

const notFound: Fetcher = async (): Promise<Probe> => ({ outcome: 'response', status: 404, text: '' });

function linkOf(url: string): Link {
  return { url, spans: [{ start: 0, end: url.length }] } as unknown as Link;
}

/** Stub fetch; records every Wayback URL requested. `cdx` decides each CDX answer. */
function stubWayback(cdx: () => Response, archivedBody = '<p>old archived words</p>'): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const u = String(input);
    requested.push(u);
    if (u.includes('/cdx/')) return cdx();
    return new Response(archivedBody, { status: 200 });
  });
  return requested;
}

const cdxCount = (r: string[]): number => r.filter(u => u.includes('/cdx/')).length;

describe('judgeLink — archive answer is all-or-nothing', () => {
  it('CDX unreachable: no resurrection, epitaph unavailable', async () => {
    stubWayback(() => new Response('down', { status: 500 }));
    const j = await judgeLink(linkOf('http://gone-a.example.com/'), {
      fetcher: notFound,
      wayback: createWaybackClient(),
      sleep: noSleep,
    });
    expect(j.verdict).toBe('dead');
    expect(j.epitaph).toBe('unavailable');
    expect(j.resurrection).toBeUndefined();
  });

  it('empty CDX: no resurrection, epitaph none', async () => {
    stubWayback(() => new Response('[]', { status: 200 }));
    const j = await judgeLink(linkOf('http://gone-b.example.com/'), {
      fetcher: notFound,
      wayback: createWaybackClient(),
      sleep: noSleep,
    });
    expect(j.epitaph).toBe('none');
    expect(j.resurrection).toBeUndefined();
  });

  it('real answer: both, and the resurrection month equals the epitaph last month', async () => {
    const requested = stubWayback(() => new Response(CDX_OK, { status: 200 }));
    const url = 'http://gone-c.example.com/';
    const j = await judgeLink(linkOf(url), { fetcher: notFound, wayback: createWaybackClient(), sleep: noSleep });
    if (typeof j.epitaph !== 'object') throw new Error('expected a dated epitaph');
    expect(j.resurrection).toBe(`https://web.archive.org/web/20120301000000/${url}`);
    expect(j.epitaph.last.slice(0, 7)).toBe('2012-03');
    expect(cdxCount(requested)).toBe(1);
    expect(requested).toHaveLength(1);
  });

  it('possessed link: one CDX request plus one id_ body request', async () => {
    const requested = stubWayback(
      () => new Response(CDX_OK, { status: 200 }),
      '<p>ancient archived content from the original site completely different words</p>',
    );
    const crossDomain: Fetcher = async (): Promise<Probe> => ({
      outcome: 'response',
      status: 200,
      finalUrl: 'https://parked-spam.example.net/',
      text: '<p>fresh modern spam advertisement buy now limited offer discount sale promotion</p>',
    });
    const j = await judgeLink(linkOf('http://haunted-d.example.com/'), {
      fetcher: crossDomain,
      wayback: createWaybackClient(),
      sleep: noSleep,
    });
    expect(j.verdict).toBe('possessed');
    expect(typeof j.epitaph).toBe('object');
    expect(j.resurrection).toBeDefined();
    expect(cdxCount(requested)).toBe(1);
    expect(requested.filter(u => u.includes('id_/'))).toHaveLength(1);
    expect(requested).toHaveLength(2);
  });

  // Property: a CDX that randomly fails never leaves a resurrection without a dated epitaph.
  it('property: a dead judgement never has a resurrection without a date epitaph (or the reverse)', async () => {
    let n = 0;
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async fails => {
        stubWayback(() =>
          fails ? new Response('down', { status: 500 }) : new Response(CDX_OK, { status: 200 }),
        );
        n += 1;
        const j: Judgement = await judgeLink(linkOf(`http://prop-${n}.example.com/`), {
          fetcher: notFound,
          wayback: createWaybackClient(),
          sleep: noSleep,
        });
        const dated = typeof j.epitaph === 'object';
        return dated === (j.resurrection !== undefined) && dated === !fails;
      }),
      { numRuns: 40 },
    );
  });
});
