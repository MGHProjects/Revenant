/**
 * Revenant CLI — revenant <file|url> [--fix] [--json]
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */

import { readFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { archiveNote } from '../core/archive-note.js';
import { patch } from '../core/patch.js';
import type { CliOutput, Fetcher, Judgement, Wayback } from '../core/types.js';
import { scan } from '../net/scan.js';
import type { InputKind } from '../net/scan.js';
import { fetcher as defaultFetcher } from '../net/fetcher.js';
import { createWaybackClient } from '../net/wayback.js';

// ---------------------------------------------------------------------------
// Kind inference
// ---------------------------------------------------------------------------

async function inferKind(
  arg: string,
): Promise<{ kind: InputKind; source: string; filePath: string | null }> {
  if (arg.startsWith('http://') || arg.startsWith('https://')) {
    return { kind: 'url', source: arg, filePath: null };
  }

  // owner/repo pattern — only if no actual file exists at that path
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(arg) && !existsSync(arg)) {
    return { kind: 'repo', source: arg, filePath: null };
  }

  // File on disk
  let content: string;
  try {
    content = await readFile(arg, 'utf8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`revenant: cannot read file '${arg}': ${message}`), {
      exitCode: 1,
    });
  }

  const ext = arg.toLowerCase();
  const kind: InputKind = ext.endsWith('.html') || ext.endsWith('.htm') ? 'html' : 'markdown';
  return { kind, source: content, filePath: arg };
}

// ---------------------------------------------------------------------------
// Testable core: accepts injectable argv, fetcher, wayback
// ---------------------------------------------------------------------------

export interface RunCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Output sink. Each call receives one line without its trailing newline. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export function summaryLine(judgements: Judgement[]): string {
  const count = (v: Judgement['verdict']): number => judgements.filter(j => j.verdict === v).length;
  const n = judgements.length;
  return (
    `${n} ${n === 1 ? 'link' : 'links'}: ${count('alive')} alive, ${count('dead')} dead, ` +
    `${count('possessed')} possessed, ${count('restless')} restless`
  );
}

export async function runCli(
  argv: string[],
  injectedFetcher?: Fetcher,
  injectedWayback?: Wayback,
  io?: CliIo,
): Promise<RunCliResult> {
  let stdoutBuf = '';
  let stderrBuf = '';

  const sink: CliIo = {
    out: line => {
      stdoutBuf += line + '\n';
      io?.out(line);
    },
    err: line => {
      stderrBuf += line + '\n';
      io?.err(line);
    },
  };
  const writeTo = (buf: 'stdout' | 'stderr', text: string): void => {
    const line = text.endsWith('\n') ? text.slice(0, -1) : text;
    if (buf === 'stdout') sink.out(line);
    else sink.err(line);
  };
  const fixFlag = argv.includes('--fix');
  const jsonFlag = argv.includes('--json');
  const input = argv.find(a => !a.startsWith('--'));

  if (!input) {
    writeTo('stderr', 'Usage: revenant <file|url|owner/repo> [--fix] [--json]\n');
    return { exitCode: 2, stdout: stdoutBuf, stderr: stderrBuf };
  }

  let inferResult: { kind: InputKind; source: string; filePath: string | null };
  try {
    inferResult = await inferKind(input);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    writeTo('stderr', `${message}\n`);
    const exitCode = (err as { exitCode?: number }).exitCode ?? 1;
    return { exitCode, stdout: stdoutBuf, stderr: stderrBuf };
  }

  const { kind, source, filePath } = inferResult;

  // --fix on a URL is an error.
  if (fixFlag && filePath === null) {
    const msg = '--fix requires a file path, not a URL';
    if (jsonFlag) {
      writeTo('stderr', JSON.stringify({ error: msg }) + '\n');
    } else {
      writeTo('stderr', `Error: ${msg}\n`);
    }
    return { exitCode: 2, stdout: stdoutBuf, stderr: stderrBuf };
  }

  const fetcher = injectedFetcher ?? defaultFetcher;
  const wayback = injectedWayback ?? createWaybackClient();
  const judgements: Judgement[] = [];
  const stream = !jsonFlag && !fixFlag;

  for await (const event of scan(source, kind, fetcher, wayback)) {
    if (event.type === 'judgement') {
      const j = event.judgement;
      judgements.push(j);
      if (stream && j.verdict !== 'alive') {
        const resurrection = j.resurrection ?? archiveNote(j) ?? '—';
        writeTo('stdout', `[${j.verdict}] ${j.link.url} — ${j.reason} (${resurrection})\n`);
      }
    } else if (event.type === 'error') {
      writeTo('stderr', `revenant: ${event.message}\n`);
    }
  }

  // --fix: overwrite the original file with patched content.
  if (fixFlag && filePath !== null) {
    const patched = patch(source, judgements, new Set());
    writeFileSync(filePath, patched, 'utf8');
    const patchedCount = judgements.filter(
      j => (j.verdict === 'dead' || j.verdict === 'possessed') && j.resurrection !== undefined,
    ).length;
    writeTo('stderr', `Patched ${patchedCount} links in ${filePath}\n`);
  }

  if (jsonFlag) {
    // --json: one document at the end, in document order (first span start).
    const ordered = [...judgements].sort(
      (a, b) => (a.link.spans[0]?.start ?? 0) - (b.link.spans[0]?.start ?? 0),
    );
    const cliOutput: CliOutput = {
      links: ordered.map(j => ({
        url: j.link.url,
        verdict: j.verdict,
        reason: j.reason,
        ...(j.resurrection !== undefined ? { resurrection: j.resurrection } : {}),
        ...(j.epitaph !== undefined ? { epitaph: j.epitaph } : {}),
        spans: j.link.spans,
      })),
    };
    writeTo('stdout', JSON.stringify(cliOutput, null, 2) + '\n');
  }

  writeTo('stderr', summaryLine(judgements) + '\n');
  // Exit 1 if any dead or possessed; 0 otherwise.
  const hasCritical = judgements.some(
    j => j.verdict === 'dead' || j.verdict === 'possessed',
  );
  return { exitCode: hasCritical ? 1 : 0, stdout: stdoutBuf, stderr: stderrBuf };
}
