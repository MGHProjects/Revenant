---
inclusion: always
---

# Structure

```
src/
  core/        pure engine: extract.ts, classify.ts, similarity.ts, patch.ts, guard.ts, types.ts
  net/         the only code that touches the network: fetcher.ts, wayback.ts
  worker/      Hono app: POST /api/scan (SSE stream), static assets
  cli/         revenant <file|url> [--fix] [--json]
  mcp/         stdio MCP server: check_links, resurrect
web/           Vite app: index.html, main.ts, graveyard.ts, styles.css
test/          *.test.ts (unit) and *.prop.test.ts (fast-check)
samples/       haunted-readme.md — the one-click sample; every link in it was verified by hand
docs/brief/    human-written input for the spec: requirements, design brief, calibration data
.kiro/         steering, specs, hooks, agents — committed, never ignored
```

- One-way imports: `worker`, `cli`, `mcp`, `web` → `net` → `core`. `core` imports nothing of ours.
- Shared types live in `src/core/types.ts` only. The web app imports types from there.
- Files are kebab-case, one concept per file, no `index.ts` barrels, no `utils.ts`.
- A property test file names the property it checks: `// Property 3: patch is idempotent`.
