/**
 * resolveRepoReadme(slug, fetchImpl?, githubToken?) — fetch a GitHub repository's README as text.
 *
 * Shared by the Worker (`POST /api/resolve`) and `scan.ts` (CLI and MCP).
 *
 * 1. raw.githubusercontent.com/{o}/{r}/HEAD/{name} for README.md, readme.md, README, Readme.md,
 *    README.markdown, in that order, sequentially, stopping at the first 200. Not API-limited.
 *    All of these are read as Markdown (plain text parses as Markdown). No token is sent here.
 * 2. Only when none answered 200: GET api.github.com/repos/{o}/{r}/readme (any file name, docs/).
 *    `githubToken`, when given, is sent as a Bearer token to the API only. It is a parameter
 *    because src/net must not read process.env (it also runs in the Worker); the CLI entry and
 *    the Worker handler supply it. It is never logged or put in an error message.
 *
 * Subrequest budget (`/api/resolve` has its own 50): worst case 5 raw + 1 API = 6; a hit on
 * README.md costs 1.
 */

import { decodeUtf8, discardBody, readCapped } from './read-capped.js';
import { USER_AGENT } from './user-agent.js';

const SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TIMEOUT_MS = 8_000;
const RAW_HOST = 'raw.githubusercontent.com';
const RAW_NAMES = ['README.md', 'readme.md', 'README', 'Readme.md', 'README.markdown'] as const;

export type ReadmeErrorCode = 'not-found' | 'rate-limited' | 'invalid' | 'unavailable';

export type ReadmeResult =
  | { ok: true; source: string; kind: 'markdown' | 'html' }
  | { ok: false; code: ReadmeErrorCode; message: string };

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

const MESSAGES: Record<ReadmeErrorCode, string> = {
  'not-found': 'Repository not found, or it has no README.',
  'rate-limited': 'GitHub rate limit reached, paste the document instead.',
  invalid: 'Input must be in owner/repo format.',
  unavailable: 'Could not reach GitHub. Try again.',
};

function fail(code: ReadmeErrorCode): ReadmeResult {
  return { ok: false, code, message: MESSAGES[code] };
}

/** Thrown for network errors, timeouts and unreadable bodies. */
class Unreachable extends Error {}

interface Reply {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

/** Bodies are read only for 200; any other status cancels its body and returns no bytes. */
async function get(f: FetchImpl, url: string, headers: Record<string, string>): Promise<Reply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await f(url, { signal: controller.signal, headers });
    if (response.status !== 200) {
      await discardBody(response);
      return { status: response.status, headers: response.headers, bytes: new Uint8Array(0) };
    }
    const bytes = await readCapped(response);
    return { status: response.status, headers: response.headers, bytes };
  } catch {
    throw new Unreachable();
  } finally {
    clearTimeout(timer);
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function kindOf(name: unknown): 'markdown' | 'html' {
  if (typeof name !== 'string') return 'markdown';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return ext === 'html' || ext === 'htm' ? 'html' : 'markdown';
}

function isRateLimited(reply: Reply): boolean {
  if (reply.status === 429) return true;
  return reply.status === 403 && reply.headers.get('x-ratelimit-remaining') === '0';
}

function isRawGithubUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === RAW_HOST;
  } catch {
    return false;
  }
}

export async function resolveRepoReadme(
  slug: string,
  fetchImpl?: FetchImpl,
  githubToken?: string,
): Promise<ReadmeResult> {
  if (!SLUG_PATTERN.test(slug)) return fail('invalid');
  const f: FetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  const [owner, repo] = slug.split('/') as [string, string];

  // Step 1: raw, sequential. Anything but 200 (404, 429, 5xx, network error) tries the next name.
  for (const name of RAW_NAMES) {
    try {
      const reply = await get(f, `https://${RAW_HOST}/${owner}/${repo}/HEAD/${name}`, {
        'User-Agent': USER_AGENT,
      });
      if (reply.status === 200) {
        return { ok: true, source: decodeUtf8(reply.bytes), kind: 'markdown' };
      }
    } catch {
      // next name
    }
  }

  // Step 2: the API.
  try {
    const apiHeaders: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    };
    if (githubToken) apiHeaders['Authorization'] = `Bearer ${githubToken}`;
    const reply = await get(f, `https://api.github.com/repos/${owner}/${repo}/readme`, apiHeaders);

    if (isRateLimited(reply)) return fail('rate-limited');
    if (reply.status === 404) return fail('not-found');
    if (reply.status !== 200) return fail('unavailable');

    let data: unknown;
    try {
      data = JSON.parse(decodeUtf8(reply.bytes));
    } catch {
      return fail('unavailable');
    }
    if (typeof data !== 'object' || data === null) return fail('unavailable');
    const rec = data as Record<string, unknown>;
    const kind = kindOf(rec['name']);

    if (rec['encoding'] === 'base64' && typeof rec['content'] === 'string' && rec['content'].trim() !== '') {
      try {
        return { ok: true, source: decodeUtf8(base64ToBytes(rec['content'])), kind };
      } catch {
        return fail('unavailable');
      }
    }

    if (isRawGithubUrl(rec['download_url'])) {
      const raw = await get(f, rec['download_url'], { 'User-Agent': USER_AGENT });
      if (raw.status === 200) return { ok: true, source: decodeUtf8(raw.bytes), kind };
      if (raw.status === 404) return fail('not-found');
    }
    return fail('unavailable');
  } catch {
    return fail('unavailable');
  }
}
