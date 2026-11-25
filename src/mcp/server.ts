#!/usr/bin/env node
/**
 * Revenant MCP server (stdio) — tools: check_links, resurrect.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Fetcher, Judgement, Wayback } from '../core/types.js';
import { archiveNote } from '../core/archive-note.js';
import { scan } from '../net/scan.js';
import { fetcher as defaultFetcher } from '../net/fetcher.js';
import { createWaybackClient } from '../net/wayback.js';

export interface McpDeps {
  fetcher: Fetcher;
  wayback: Wayback;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// ---------------------------------------------------------------------------
// check_links
// ---------------------------------------------------------------------------

export async function handleCheckLinks(
  args: { text?: string; urls?: string[] },
  deps: McpDeps,
  now: Date = new Date(),
): Promise<ToolResult> {
  const hasText = typeof args.text === 'string' && args.text.trim() !== '';
  const urls = Array.isArray(args.urls) ? args.urls.filter(u => typeof u === 'string') : [];
  // Bare URLs, one per line; a newline inside a URL would otherwise split it.
  const source = hasText ? args.text! : urls.map(u => u.replace(/\s+/g, '')).join('\n');

  if (source.trim() === '') return fail('no URLs found');

  const judgements: Judgement[] = [];
  let total = 0;
  let capped = false;
  for await (const event of scan(source, 'markdown', deps.fetcher, deps.wayback, now)) {
    if (event.type === 'meta') {
      total = event.total;
      capped = event.capped;
    } else if (event.type === 'judgement') {
      judgements.push(event.judgement);
    } else {
      return fail(event.message);
    }
  }

  if (total === 0) return fail('no URLs found');

  const withNotes = judgements.map(j => {
    const archiveNoteText = archiveNote(j);
    return archiveNoteText === undefined ? j : { ...j, archiveNote: archiveNoteText };
  });
  return ok({ total, capped, capLimit: 200, judgements: withNotes });
}

// ---------------------------------------------------------------------------
// resurrect
// ---------------------------------------------------------------------------

export async function handleResurrect(
  args: { url?: string; date?: string },
  deps: McpDeps,
): Promise<ToolResult> {
  const url = args.url;
  if (typeof url !== 'string' || url.trim() === '') return fail('url is required');
  if (args.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    return fail('date must be YYYY-MM-DD');
  }

  let lost = false;
  let unknown = false;
  let snapshot: { url: string; date: string } | undefined;

  if (deps.wayback.getClosestSnapshot) {
    const r = await deps.wayback.getClosestSnapshot(url, args.date);
    if (r.status === 'found') snapshot = { url: r.url, date: r.date };
    else if (r.status === 'none') lost = true;
    else unknown = true;
  } else {
    // Fallback for Wayback implementations without a closest-date lookup.
    const [res, epi] = await Promise.all([
      deps.wayback.getResurrection(url),
      deps.wayback.getEpitaph(url),
    ]);
    if (res !== undefined) snapshot = { url: res, date: '' };
    else if (epi === 'unavailable') unknown = true;
    else lost = true;
  }

  if (snapshot) return ok({ url, found: true, snapshotUrl: snapshot.url, snapshotDate: snapshot.date });
  return ok({ url, found: false, lost, archiveAvailability: unknown ? 'unknown' : 'known' });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createMcpServer(deps: McpDeps): Server {
  const server = new Server(
    { name: 'revenant', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'check_links',
        description:
          'Check links for rot. Pass `text` (Markdown) or `urls`. Returns one verdict (alive, dead, possessed, restless) per distinct URL, with Wayback resurrection when dead or possessed. Max 200 URLs.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Markdown text containing links' },
            urls: { type: 'array', items: { type: 'string' }, description: 'URLs to check' },
          },
        },
      },
      {
        name: 'resurrect',
        description:
          'Find the Wayback Machine snapshot of a URL closest to a date (default: most recent).',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            date: { type: 'string', description: 'YYYY-MM-DD (optional)' },
          },
          required: ['url'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (request.params.name === 'check_links') {
        return await handleCheckLinks(args as { text?: string; urls?: string[] }, deps);
      }
      if (request.params.name === 'resurrect') {
        return await handleResurrect(args as { url?: string; date?: string }, deps);
      }
      return fail(`unknown tool: ${request.params.name}`);
    } catch (err: unknown) {
      return fail(err instanceof Error ? err.message : 'internal error');
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// stdio entry point — only when run directly
// ---------------------------------------------------------------------------

const isEntryPoint = (() => {
  try {
    const entryUrl = new URL(`file://${process.argv[1]!.replace(/\\/g, '/')}`).href;
    const moduleUrl = import.meta.url;
    return entryUrl === moduleUrl || moduleUrl.endsWith(process.argv[1]!.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  const server = createMcpServer({ fetcher: defaultFetcher, wayback: createWaybackClient() });
  server.connect(new StdioServerTransport()).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`revenant-mcp: ${message}\n`);
    process.exit(1);
  });
}
