import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/worker/index.ts';
import { resolveRepoReadme } from '../src/net/github-readme.ts';
import { scan } from '../src/net/scan.ts';
import type { Fetcher, ScanEvent, Wayback } from '../src/core/types.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

const API = 'https://api.github.com/repos/o/r/readme';
const RAW = 'https://raw.githubusercontent.com/o/r/HEAD/README.md';

function b64(text: string, wrap = false): string {
  const s = Buffer.from(text, 'utf-8').toString('base64');
  return wrap ? (s.match(/.{1,16}/g) ?? []).join('\n') + '\n' : s;
}

function apiBody(text: string, name = 'README.md'): Response {
  return new Response(JSON.stringify({ name, encoding: 'base64', content: b64(text, true) }), {
    status: 200,
  });
}

type Routes = Record<string, () => Response | Promise<Response>>;
function stub(routes: Routes): { f: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const route = routes[url];
    if (!route) return new Response('no route', { status: 500 });
    return route();
  }) as typeof fetch;
  return { f, calls };
}

describe('resolveRepoReadme', () => {
  it('decodes an em dash and an emoji exactly, from base64 with newlines', async () => {
    const text = '# Title — a 🎃 README\n[x](https://example.org)\n';
    const { f, calls } = stub({ [API]: () => apiBody(text) });
    const r = await resolveRepoReadme('o/r', f);
    expect(r).toEqual({ ok: true, source: text, kind: 'markdown' });
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['Accept']).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(headers['User-Agent']).toMatch(/^Revenant/);
  });

  it('resolves readme.markdown through /readme as markdown, and .html as html', async () => {
    const md = stub({ [API]: () => apiBody('hi', 'readme.markdown') });
    expect(await resolveRepoReadme('o/r', md.f)).toEqual({ ok: true, source: 'hi', kind: 'markdown' });
    const html = stub({ [API]: () => apiBody('<p>hi</p>', 'index.htm') });
    expect(await resolveRepoReadme('o/r', html.f)).toMatchObject({ ok: true, kind: 'html' });
  });

  it('falls back to download_url on raw.githubusercontent.com when content is empty', async () => {
    const dl = 'https://raw.githubusercontent.com/o/r/main/README.rst.md';
    const { f } = stub({
      [API]: () =>
        new Response(JSON.stringify({ name: 'README.md', encoding: 'none', content: '', download_url: dl })),
      [dl]: () => new Response('big — readme'),
    });
    expect(await resolveRepoReadme('o/r', f)).toEqual({ ok: true, source: 'big — readme', kind: 'markdown' });
  });

  it('does not follow a download_url on another host', async () => {
    const { f, calls } = stub({
      [API]: () =>
        new Response(
          JSON.stringify({ name: 'README.md', encoding: 'none', content: '', download_url: 'https://evil.example/x' }),
        ),
    });
    const r = await resolveRepoReadme('o/r', f);
    expect(r).toMatchObject({ ok: false, code: 'unavailable' });
    expect(calls).toHaveLength(1);
  });

  it('404 is not-found', async () => {
    const { f } = stub({ [API]: () => new Response('{}', { status: 404 }) });
    expect(await resolveRepoReadme('o/r', f)).toEqual({
      ok: false,
      code: 'not-found',
      message: 'Repository not found, or it has no README.',
    });
  });

  it('403 with x-ratelimit-remaining 0 uses the raw fallback', async () => {
    const { f, calls } = stub({
      [API]: () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      [RAW]: () => new Response('raw — text'),
    });
    expect(await resolveRepoReadme('o/r', f)).toEqual({ ok: true, source: 'raw — text', kind: 'markdown' });
    expect(calls.map(c => c.url)).toEqual([API, RAW]);
  });

  it('a plain 403 is not a rate limit', async () => {
    const { f } = stub({ [API]: () => new Response('{}', { status: 403 }) });
    expect(await resolveRepoReadme('o/r', f)).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('rate-limited with a 404 raw fallback gives the rate-limit message', async () => {
    const { f } = stub({
      [API]: () => new Response('{}', { status: 429 }),
      [RAW]: () => new Response('nope', { status: 404 }),
    });
    expect(await resolveRepoReadme('o/r', f)).toEqual({
      ok: false,
      code: 'rate-limited',
      message: 'GitHub rate limit reached, paste the document instead.',
    });
  });

  it('a network error is unavailable', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await resolveRepoReadme('o/r', f)).toEqual({
      ok: false,
      code: 'unavailable',
      message: 'Could not reach GitHub. Try again.',
    });
  });

  it('rejects a malformed slug without fetching', async () => {
    const { f, calls } = stub({});
    expect(await resolveRepoReadme('not a slug', f)).toMatchObject({ ok: false, code: 'invalid' });
    expect(calls).toHaveLength(0);
  });
});

describe('POST /api/resolve (repo)', () => {
  async function resolve(input: string) {
    const res = await app.request('/api/resolve', {
      method: 'POST',
      body: JSON.stringify({ input, kind: 'repo' }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('maps each outcome to its status code', async () => {
    vi.stubGlobal('fetch', stub({ [API]: () => apiBody('é — 🎃') }).f);
    expect(await resolve('o/r')).toEqual({ status: 200, body: { source: 'é — 🎃', kind: 'markdown' } });

    vi.stubGlobal('fetch', stub({ [API]: () => new Response('{}', { status: 404 }) }).f);
    expect(await resolve('o/r')).toEqual({
      status: 404,
      body: { error: 'Repository not found, or it has no README.' },
    });

    vi.stubGlobal(
      'fetch',
      stub({
        [API]: () => new Response('{}', { status: 429 }),
        [RAW]: () => new Response('', { status: 404 }),
      }).f,
    );
    expect(await resolve('o/r')).toMatchObject({ status: 429 });

    vi.stubGlobal('fetch', stub({ [API]: () => new Response('x', { status: 500 }) }).f);
    expect(await resolve('o/r')).toMatchObject({ status: 502 });

    expect(await resolve('bad slug')).toMatchObject({ status: 400 });
  });
});

describe('scan() repo path', () => {
  const never: Fetcher = async () => ({ outcome: 'timeout' });
  const wayback: Wayback = {
    async getArchive() {
      return { epitaph: 'none' as const };
    },
    async getSnapshotText() {
      return { status: 'none' } as never;
    },
  };

  async function run(input: string): Promise<ScanEvent[]> {
    const out: ScanEvent[] = [];
    for await (const e of scan(input, 'repo', never, wayback)) out.push(e);
    return out;
  }

  it('uses the shared resolver: /readme endpoint and exact UTF-8 text', async () => {
    const { f, calls } = stub({ [API]: () => apiBody('# — 🎃\n') });
    vi.stubGlobal('fetch', f);
    const events = await run('o/r');
    expect(calls[0]!.url).toBe(API);
    expect(events[0]).toMatchObject({ type: 'meta', total: 0 });
  });

  it('reports the shared message on failure', async () => {
    vi.stubGlobal('fetch', stub({ [API]: () => new Response('{}', { status: 404 }) }).f);
    expect(await run('o/r')).toEqual([
      { type: 'error', message: 'Repository not found, or it has no README.' },
    ]);
  });
});
