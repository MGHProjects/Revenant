#!/usr/bin/env node
import { startStdio } from './server.js';

startStdio().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`revenant-mcp: ${message}\n`);
  process.exit(1);
});
