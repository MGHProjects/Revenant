# Task outline — Revenant

Suggested order only. Kiro generates the real `tasks.md`.

- [ ] 1. Scaffold the project
  - `package.json` (ESM, scripts from tech.md), strict `tsconfig.json`, Vitest + fast-check, `wrangler.toml` with static assets, folders from structure.md
  - _Requirements: all_

- [ ] 2. Core types and guard
  - [ ] 2.1 Write `src/core/types.ts` exactly as in design.md
  - [ ] 2.2 Implement `guard(url)`
    - _Requirements: 5.1_
  - [ ] 2.3 Property test: the guard holds (Property 7)
    - _Requirements: 5.1_

- [ ] 3. Link extraction
  - [ ] 3.1 Implement `extract` for Markdown (inline, reference, autolink, bare; skip fenced code) and HTML (`<a href>`), with byte spans and dedupe
    - _Requirements: 1.1, 1.2, 1.4, 1.5_
  - [ ] 3.2 Property test: extraction round-trips (Property 4)
    - _Requirements: 1.1, 1.4, 1.5_

- [ ] 4. Similarity and classification
  - [ ] 4.1 Implement `visibleText` and `similarity`
    - _Requirements: 2.4_
  - [ ] 4.2 Property test: similarity is a proper measure (Property 5)
    - _Requirements: 2.4_
  - [ ] 4.3 Implement `classify(probe, snapshotText?)` with reasons
    - _Requirements: 2.1–2.8_
  - [ ] 4.4 Unit tests per branch + property test: never cry wolf (Property 6)
    - _Requirements: 2.3, 2.7, 2.8_

- [ ] 5. Patching
  - [ ] 5.1 Implement `patch(source, judgements, excluded)`
    - _Requirements: 4.1–4.5_
  - [ ] 5.2 Property tests: only link targets change, the living are left alone, idempotent (Properties 1–3)
    - _Requirements: 4.2, 4.3, 4.4_

- [ ] 6. Network layer
  - [ ] 6.1 Implement `fetcher` (timeout, byte cap, manual redirects with guard on each hop, one 5xx retry)
    - _Requirements: 2.2, 5.2, 5.3_
  - [ ] 6.2 Implement `wayback` (availability, CDX first/last, raw snapshot text, cache, 429 back-off)
    - _Requirements: 3.1–3.4_
  - [ ] 6.3 Implement `scan` async generator with a pool of 6 and the 200-link cap
    - _Requirements: 1.3, 1.6, 5.4_
  - [ ] 6.4 Integration test of `scan` with a fake Fetcher covering all four verdicts
    - _Requirements: 2, 3_

- [ ] 7. Worker API
  - Hono app, `POST /api/scan` streaming SSE (`meta`, `judgement`, `done`), 1 MB body limit, JSON errors, static assets
  - _Requirements: 6.1, 5_

- [ ] 8. Graveyard UI
  - [ ] 8.1 Page shell: input (paste / URL / repo), sample-document button, palette and type from costume.md
    - _Requirements: 6.8_
  - [ ] 8.2 SSE client + state array + ledger table with labels, reasons, exclude checkboxes
    - _Requirements: 6.1, 6.2, 6.5, 4.5_
  - [ ] 8.3 SVG scene: window / tombstone / zombie hand / fog, epitaph text, height by lifespan, moon progress
    - _Requirements: 6.1, 6.2, 6.3_
  - [ ] 8.4 Resurrect action and "download patched document" (browser-side `patch`)
    - _Requirements: 6.4, 6.5, 4.1_
  - [ ] 8.5 Accessibility pass: keyboard path, batched live region, reduced motion, contrast check
    - _Requirements: 6.6, 6.7_

- [ ] 9. CLI
  - `revenant <file|url> [--fix] [--json]`, exit codes, `bin` entry
  - _Requirements: 7.1–7.3_

- [ ] 10. MCP server
  - [ ] 10.1 stdio server with `check_links` and `resurrect`
    - _Requirements: 8.1–8.3_
  - [ ] 10.2 Register it in `.kiro/settings/mcp.json` and use it from Kiro to check this repo's own README
    - _Requirements: 8.1_

- [ ] 11. Ship
  - Deploy to Cloudflare, README with screenshots and run instructions, verify the sample shows every verdict on the live URL
  - _Requirements: 6.8_
