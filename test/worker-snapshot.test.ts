import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/worker/index.ts';

// Worker-level tests for a cross-domain 2xx whose archive lookup fails (task 14.10).

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The target redirects to microsoft.com (200). Archive answers are chosen by `archive`. */
function stub(archive: () => Response) {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const u = String(input);
    if (u.includes('archive.org')) return archive();
    if (u.startsWith('https://www.microsoft.com')) {
      return new Response('<html><body>Microsoft home page</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(null, { status: 301, headers: { location: 'https://www.microsoft.com/' } });
  });
}

async function scan(url: string): Promise<{ verdict: string; reason: string }> {
  const res = await app.request('/api/scan', {
    method: 'POST',
    body: JSON.stringify({ urls: [url] }),
  });
  const { judgements } = (await res.json()) as { judgements: Array<{ verdict: string; reason: string }> };
  return judgements[0]!;
}

describe('POST /api/scan cross-domain redirect', () => {
  it('archive unreachable → restless', async () => {
    stub(() => new Response('down', { status: 503 }));
    const j = await scan('http://www.codeplex-unreachable.com/');
    expect(j.verdict).toBe('restless');
    expect(j.reason).toBe(
      'Redirects to microsoft.com; the archive could not be reached to compare. Not judged.',
    );
  });

  it('archive answers with no capture → alive (unchanged)', async () => {
    stub(() => new Response('[]', { status: 200 }));
    const j = await scan('http://www.kiko-nocapture.com/');
    expect(j.verdict).toBe('alive');
    expect(j.reason).toBe('Redirects to microsoft.com; no archived copy to compare.');
  });
});
