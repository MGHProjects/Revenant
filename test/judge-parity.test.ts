import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/worker/index.ts';
import { scan } from '../src/net/scan.ts';
import { fetcher } from '../src/net/fetcher.ts';
import { createWaybackClient } from '../src/net/wayback.ts';
import type { Judgement } from '../src/core/types.ts';

// Parity: the Worker (/api/scan) and scan() (CLI and MCP) share judgeLink, so one link
// gets one verdict and one reason in both doors (task 15.3, review item A3).

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROSE =
  'Lanterns of the old harbour keep a ledger of every ship that docked here, noting cargo, ' +
  'weather, pilots and the names of the families who waited on the quay for news from the sea. ' +
  'The ledger is read aloud each winter and the pilots add a verse for the ships that never returned.';

/** Markup, a big script and a big style around the visible text. Raw HTML looks nothing like PROSE. */
function page(visible: string): string {
  const script = Array.from({ length: 400 }, (_, i) => `var track${i}=window.analytics${i}(${i});`).join('\n');
  const style = Array.from({ length: 400 }, (_, i) => `.cls${i}{margin:${i}px;color:#${(i * 977) % 999999};}`).join('\n');
  return (
    `<!doctype html><html><head><title>t</title><style>${style}</style><script>${script}</script></head>` +
    `<body><div class="wrap"><p>${visible}</p></div></body></html>`
  );
}

/**
 * Stub the network. The cited URL redirects to another domain (200). Wayback has one
 * capture whose body is `archived`; the live page body is `live`.
 */
function stub(live: string, archived: string) {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const u = String(input);
    if (u.startsWith('https://web.archive.org/cdx/')) {
      return new Response(
        JSON.stringify([
          ['timestamp', 'length'],
          ['20150101000000', '2000'],
          ['20150201000000', '2000'],
        ]),
        { status: 200 },
      );
    }
    if (u.includes('web.archive.org/web/')) return new Response(archived, { status: 200 });
    if (u.startsWith('https://www.newowner.example.net')) {
      return new Response(live, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response(null, { status: 301, headers: { location: 'https://www.newowner.example.net/' } });
  });
}

async function viaWorker(url: string): Promise<Judgement> {
  const res = await app.request('/api/scan', { method: 'POST', body: JSON.stringify({ urls: [url] }) });
  const { judgements } = (await res.json()) as { judgements: Judgement[] };
  return judgements[0]!;
}

async function viaScan(url: string): Promise<Judgement> {
  let found: Judgement | undefined;
  for await (const ev of scan(`[x](${url})`, 'markdown', fetcher, createWaybackClient())) {
    if (ev.type === 'judgement') found = ev.judgement;
  }
  return found!;
}

describe('Worker and scan() agree on a cross-domain redirect', () => {
  it('live visible text matches the snapshot → alive in both doors', async () => {
    // Before the fix scan() compared the raw HTML (scripts and styles included) with the
    // snapshot's visible text, scored under 0.2 and reported `possessed`.
    stub(page(PROSE), page(PROSE));
    const w = await viaWorker('http://www.parity-alive-w.example.org/');
    const s = await viaScan('http://www.parity-alive-s.example.org/');
    expect(w.verdict).toBe('alive');
    expect(w.reason).toBe('Answers 200 with the page you cited.');
    expect(s.verdict).toBe(w.verdict);
    expect(s.reason).toBe(w.reason);
  });

  it('unrelated live page → possessed in both doors', async () => {
    stub(
      page('Buy cheap pills online today, casino bonuses, win big prizes, click here for free spins and crypto offers now'),
      page(PROSE),
    );
    const w = await viaWorker('http://www.parity-zombie-w.example.org/');
    const s = await viaScan('http://www.parity-zombie-s.example.org/');
    expect(w.verdict).toBe('possessed');
    expect(s.verdict).toBe('possessed');
    expect(s.reason).toBe(w.reason);
    expect(s.epitaph).toEqual(w.epitaph);
    expect(s.resurrection).toBeDefined();
  });
});
