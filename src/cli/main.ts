#!/usr/bin/env node
import { runCli } from './run.js';

try {
  const { exitCode } = await runCli(process.argv.slice(2), undefined, undefined, {
    out: line => process.stdout.write(line + '\n'),
    err: line => process.stderr.write(line + '\n'),
  });
  process.exitCode = exitCode;
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`revenant: unexpected error: ${message}\n`);
  process.exitCode = 1;
}
