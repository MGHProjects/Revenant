#!/usr/bin/env node
/**
 * Revenant CLI — revenant <file|url> [--fix] [--json]
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */

import { readFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { patch } from '../core/patch.js';
import type { CliOutput, Fetcher, Judgement, ScanEvent, Wayback } from '../core/types.js';
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

export async function runCli(
  argv: string[],
  injectedFetcher?: Fetcher,
  injectedWayback?: Wayback,
): Promise<RunCliResult> {
  let stdoutBuf = '';
  let stderrBuf = '';

  const writeTo = (buf: 'stdout' | 'stderr', text: string): void => {
    if (buf === 'stdout') {
      stdoutBuf += text;
    } else {
      stderrBuf += text;
    }
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
  const events: ScanEvent[] = [];

  for await (const event of scan(source, kind, fetcher, wayback, new Date())) {
    events.push(event);
  }

  // Collect judgements from stream.
  const judgements: Judgement[] = events
    .filter((e): e is Extract<ScanEvent, { type: 'judgement' }> => e.type === 'judgement')
    .map(e => e.judgement);

  // Report any scan-level errors to stderr.
  for (const e of events) {
    if (e.type === 'error') {
      writeTo('stderr', `revenant: ${e.message}\n`);
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
    // --json: print single CliOutput JSON to stdout; suppress per-line format.
    const cliOutput: CliOutput = {
      links: judgements.map(j => ({
        url: j.link.url,
        verdict: j.verdict,
        reason: j.reason,
        ...(j.resurrection !== undefined ? { resurrection: j.resurrection } : {}),
        ...(j.epitaph !== undefined ? { epitaph: j.epitaph } : {}),
        spans: j.link.spans,
      })),
    };
    writeTo('stdout', JSON.stringify(cliOutput, null, 2) + '\n');
  } else if (!fixFlag) {
    // Default output: one line per non-alive link (skipped when --fix ran).
    const nonAlive = judgements.filter(j => j.verdict !== 'alive');
    for (const j of nonAlive) {
      const resurrection = j.resurrection ?? '—';
      writeTo(
        'stdout',
        `[${j.verdict}] ${j.link.url} — ${j.reason} (${resurrection})\n`,
      );
    }
  }

  // Exit 1 if any dead or possessed; 0 otherwise.
  const hasCritical = judgements.some(
    j => j.verdict === 'dead' || j.verdict === 'possessed',
  );
  return { exitCode: hasCritical ? 1 : 0, stdout: stdoutBuf, stderr: stderrBuf };
}

// ---------------------------------------------------------------------------
// CLI entry point (process-bound) — only runs when invoked directly
// ---------------------------------------------------------------------------

// Guard: only execute when this module is the entry point, not when imported.
// In Node.js ESM, `process.argv[1]` resolves to the entry file.
// We use a URL comparison so this doesn't fire during Vitest imports.
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
  async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const { exitCode, stdout, stderr } = await runCli(args);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exit(exitCode);
  }

  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`revenant: unexpected error: ${message}\n`);
    process.exit(1);
  });
}
