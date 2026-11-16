# Implementation Plan: Revenant

## Overview

Build Revenant as a TypeScript ESM project targeting Cloudflare Workers (web + Worker) and Node.js (CLI + MCP). The implementation follows a **pure core, thin doors** architecture: `src/core/` holds all pure functions, `src/net/` holds all I/O, and the three doors (`src/worker/`, `src/cli/`, `src/mcp/`) only orchestrate and render. The web UI lives in `web/` and is built with Vite. Tasks follow the dependency order: core types → guard → extract → similarity + classify → patch → network → Worker API → web UI → CLI → MCP → ship.

## Tasks

- [ ] 1. Scaffold project structure and tooling
  - Create `package.json` with `"type": "module"`, scripts (`dev`, `build`, `test`, `check`, `deploy`), and dependencies: `hono`, `@cloudflare/workers-types`, `@modelcontextprotocol/sdk`; devDependencies: `typescript`, `vitest`, `fast-check`, `wrangler`, `vite`.
  - Create `tsconfig.json` (root) with `"strict": true`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"target": "ES2022"`, `"lib": ["ES2022"]`, path aliases for `#core` and `#net`.
  - Create `tsconfig.web.json` extending the root config and adding `"lib": ["ES2022", "DOM"]` for the `web/` directory.
  - Create `wrangler.toml` with Worker name `revenant`, `compatibility_date`, `[assets]` pointing to `dist/` (Vite build output), and a build command.
  - Create the full directory skeleton: `src/core/`, `src/net/`, `src/worker/`, `web/`, `src/cli/`, `src/mcp/`, `test/`.
  - Add `vitest.config.ts` configuring separate include globs for `*.test.ts`, `*.prop.test.ts`, and `*.int.test.ts`.
  - _Requirements: 1, 2, 3, 4, 5, 6, 7, 8_

- [ ] 2. Core types and URL guard
  - [ ] 2.1 Write `src/core/types.ts` with the exact types from the design: `Verdict`, `Link`, `Probe`, `Epitaph`, `Judgement`, `Fetcher`, `Wayback`, `ScanEvent`.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2_
  - [ ] 2.2 Implement `guard(url: string)` in `src/core/guard.ts`: return `{ ok: false, reason }` when: scheme is not `http`/`https`; URL contains userinfo; host is an IP literal in any form (dotted-decimal, hex, octal, integer, IPv4-mapped IPv6 `::ffff:...`, link-local IPv6 `fe80::/10`, loopback `::1`, ULA `fc00::/7`, CGNAT `100.64.0.0/10`, or private/loopback IPv4: 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0.0.0.0/8); hostname is `localhost` or ends in `.local`, `.internal`, `.localhost`. Otherwise return `{ ok: true }`.
    - _Requirements: 5.1_
  - [ ] 2.3 Write unit tests for `guard` in `test/guard.test.ts` covering each blocked IP range (including hex/octal/integer notation and IPv4-mapped IPv6), each blocked hostname pattern, each scheme variant, and a URL with credentials.
    - _Requirements: 5.1_
  - [ ] 2.4 Write property test for `guard` in `test/guard.prop.test.ts` using the `arbUrl()` generator.
    - **Property 7: The guard holds** — for any URL with a blocked host (in any notation), blocked scheme, or credentials, `guard` returns `ok: false` with a non-empty reason.
    - **Validates: Requirements 5.1**

- [ ] 3. Link extraction
  - [ ] 3.1 Implement `extract(source: string, kind: 'markdown' | 'html'): Link[]` in `src/core/extract.ts`. Markdown: inline `[text](url)`, reference `[text][id]` + `[id]: url`, autolinks `<url>`, bare URLs not enclosed in `<>` or `[]()`. HTML: `href` from every `<a>`. Record byte `start`/`end` for the URL portion. Exclude URLs inside fenced blocks (`` ``` `` or `~~~`). Exclude non-http(s) schemes. Deduplicate by exact URL string; one `Link` with all spans in encounter order.
    - _Requirements: 1.1, 1.2, 1.5, 1.6_
  - [ ] 3.2 Write unit tests for `extract` in `test/extract.test.ts`: all four Markdown forms, fenced-block exclusion, deduplication, `mailto:` exclusion, HTML href extraction, mixed content.
    - _Requirements: 1.1, 1.2, 1.5, 1.6_
  - [ ] 3.3 Write property test for `extract` in `test/extract.prop.test.ts` using `arbMarkdownSource(urls)` and `arbHtmlSource(urls)` generators.
    - **Property 4: Extraction round-trips** — for any Markdown or HTML source built from a known URL list, `extract` returns exactly those URLs (minus any in generated fenced blocks), and `source.slice(span.start, span.end)` equals the URL for every span.
    - **Property 9: Deduplication invariant** — for any source with the same URL at multiple locations, `extract` returns one `Link` with span count equal to occurrence count.
    - **Validates: Requirements 1.1, 1.2, 1.5, 1.6**

- [ ] 4. Similarity, visible text, and verdict classification
  - [ ] 4.1 Implement `visible-text(html: string): string` in `src/core/visible-text.ts` using a hand-written tokenizer (no DOM dependency) that strips all tags and removes `<script>` and `<style>` block content.
    - _Requirements: 2.5_
  - [ ] 4.2 Implement `similarity(a: string, b: string): number` in `src/core/similarity.ts` as the Jaccard index over 3-word shingles. Returns `[0, 1]`; returns `0` for empty strings; symmetric. In the Worker context, similarity is computed on the first 64 KB of each string.
    - _Requirements: 2.5_
  - [ ] 4.3 Write unit tests for `similarity` in `test/similarity.test.ts` using calibration examples from `docs/brief/calibration.md` (paul graham ~1.0, kiko.com ~0.0, HN ~0.13) plus empty-string and identical-string edge cases.
    - _Requirements: 2.5_
  - [ ] 4.4 Write property test for `similarity` in `test/similarity.prop.test.ts`.
    - **Property 5: Similarity is a proper measure** — for any strings `a` and `b`, `similarity(a, b)` is in `[0, 1]`; `similarity(a, a) === 1` for non-empty `a`; `similarity(a, b) === similarity(b, a)`.
    - **Validates: Requirements 2.5**
  - [ ] 4.5 Implement the registrable-domain helper in `src/core/domain.ts`: return the last two hostname labels, treating `co.uk`, `com.au`, `org.uk`, `net.au`, `co.nz`, `org.nz`, `com.br`, `co.jp` as two-label effective TLDs.
    - _Requirements: 2.5, 2.8_
  - [ ] 4.6 Implement `classify(probe: Probe, originalUrl: string, snapshotText?: string): { verdict: Verdict; reason: string }` in `src/core/classify.ts` following the decision table exactly: `timeout` → `restless`; `network-error` → `dead`; 401/403/429 → `restless`; 404/410 → `dead`; 5xx (after retry) → `restless` with `{status} after retry`; 2xx + different domain + snapshotText + similarity < 0.2 → `possessed`; 2xx + different domain + no snapshotText → `alive`; 2xx → `alive`. Never `possessed` when `finalUrl` shares the same registrable domain as `originalUrl`.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_
  - [ ] 4.7 Write unit tests for `classify` in `test/classify.test.ts` with one `Probe` fixture per decision-table row: DNS failure, 404, 410, 5xx after retry, 401, 403, 429, timeout, 2xx same domain, 2xx cross-domain with low similarity, 2xx cross-domain no snapshot, 2xx cross-domain high similarity.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_
  - [ ] 4.8 Write property test for `classify` in `test/classify.prop.test.ts` using the `arbProbe()` generator.
    - **Property 6: Never cry wolf** — for any `Probe` with status 401/403/429, `classify` never returns `dead`; for `outcome === 'timeout'`, never returns `dead`; for 5xx (after retry), returns `restless`; for `finalUrl` sharing the same registrable domain, never returns `possessed`; every result has exactly one verdict and a non-empty reason.
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.8, 2.9**

- [ ] 5. Document patching
  - [ ] 5.1 Implement `patch(source: string, judgements: Judgement[], excluded: Set<string>): string` in `src/core/patch.ts`. Replace URL spans for `dead` or `possessed` links that have a `resurrection` and are not in `excluded`. Sort spans by `start` descending; apply right-to-left. Copy all other bytes verbatim. Leave `alive`, `restless`, unresurrectable, and excluded links unchanged.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [ ] 5.2 Write unit tests for `patch` in `test/patch.test.ts`: single dead replacement, single possessed replacement, multiple replacements, excluded links left unchanged, no dead/possessed links (source unchanged), right-to-left ordering with adjacent spans.
    - _Requirements: 4.1, 4.2, 4.3, 4.5_
  - [ ] 5.3 Write property tests for `patch` in `test/patch.prop.test.ts` using `arbMarkdownSource` and `arbJudgements(links)` generators.
    - **Property 1: Patch touches only link targets** — removing all link-span byte ranges from both `source` and `patch(source, judgements, excluded)` yields identical strings.
    - **Property 2: The living are left alone** — when every judgement is `alive` or `restless`, `patch` returns a string byte-for-byte equal to `source`.
    - **Property 3: Patch is idempotent** — applying `patch` twice (re-extracting from already-patched output, Wayback URLs judged `alive`) yields the same result as once.
    - **Property 8: Excluded links survive unchanged** — for any `dead` or `possessed` judgement with a resurrection in the excluded set, the original URL bytes appear unchanged in the output.
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5**

- [ ] 6. Network layer: fetcher, Wayback client, and scan orchestrator
  - [ ] 6.1 Implement the default `fetcher` in `src/net/fetcher.ts`. Manual redirect handling: call `guard()` on each target before following; reject after 5 redirects with `network-error`. Independent 8-second timeout returning `{ outcome: 'timeout' }` on expiry. Body size: stop reading at 512 KB and treat the truncated body as the full response (not an error).
    - _Requirements: 5.2, 5.3_
  - [ ] 6.2 Implement the Wayback client in `src/net/wayback.ts` implementing the `Wayback` interface. `getEpitaph(url)`: CDX call with `limit=1` for first, `limit=-1` for last good capture. `getResurrection(url)`: build from CDX last timestamp as `https://web.archive.org/web/{timestamp}/{url}` — no Availability API call. `getSnapshotText(url)`: fetch `https://web.archive.org/web/{timestamp}id_/{url}` and pass through `visible-text`. Cache all responses 24 h (platform Cache API in Worker, in-memory `Map` keyed by URL in CLI/MCP). On 429: wait `Retry-After` (capped 10 s), retry once; on second failure set Epitaph `'unavailable'`. On connection error, HTTP error, or no response within 10 s: Epitaph `'unavailable'`.
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [ ] 6.3 Implement `scan(input, kind, fetcher, wayback, now)` as an async generator in `src/net/scan.ts` yielding `ScanEvent`. Steps: (1) Resolve input — `'url'`: fetch page, detect Content-Type; `'repo'`: fetch GitHub README; on failure or undetectable type: yield `{ type: 'error' }` and halt. (2) `extract`. (3) Cap at 200, emit `meta` event. (4) `guard` each link; failing links yield `{ type: 'judgement', judgement: { verdict: 'restless' } }` immediately. (5) Pool of 6: `fetcher` → if 5xx retry once after 2 s → if 2xx cross-domain: `wayback.getSnapshotText` → `classify` → if `dead`/`possessed`: `wayback.getEpitaph` + build Resurrection from CDX last timestamp → yield `{ type: 'judgement' }`.
    - _Requirements: 1.3, 1.4, 1.6, 1.7, 2.2, 5.4_
  - [ ] 6.4 Write unit tests for the Wayback client in `test/wayback.test.ts`: CDX success (first + last), Resurrection URL built from CDX timestamp (no `id_`, correct rendering form `web/{timestamp}/{url}`), snapshot text fetch, 429 back-off, CDX unreachable → `'unavailable'`.
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [ ] 6.5 Write a property test for the concurrency pool in `test/scan.prop.test.ts` using an instrumented fake `Fetcher`.
    - **Property 10: Concurrency cap invariant** — for any scan over more than 6 URLs, in-flight `fetcher` calls never exceed 6 simultaneously.
    - **Validates: Requirements 5.4**
  - [ ] 6.6 Write a property test for the deduplication invariant at scan level in `test/scan.prop.test.ts`.
    - **Property 9: Deduplication invariant** — for any source containing a URL more than once, `scan` calls `fetcher` for that URL exactly once and reports all source locations in the resulting `Judgement`.
    - **Validates: Requirements 1.6**
  - [ ] 6.7 Write an integration test for `scan` in `test/scan.int.test.ts` using fake `Fetcher` and fake `Wayback` over a 10-link document. Cover: DNS failure (→ `dead`), 404 (→ `dead`), 5xx with successful retry (→ `alive`), 5xx with failed retry (→ `restless`), 403 (→ `restless`), timeout (→ `restless`), 2xx same-domain redirect (→ `alive`), 2xx cross-domain with low-similarity snapshot (→ `possessed`).
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2_

- [ ] 7. Checkpoint — core and network complete
  - Run `npm test` (Vitest) and `npm run check` (tsc --noEmit). All tests must pass and type-checker must report no errors before continuing to the Worker and UI.

- [ ] 8. Worker HTTP API
  - [ ] 8.1 Create the Hono application in `src/worker/index.ts`. Register `POST /api/scan`: accept `{ urls: string[] }` (at most 3); enforce the 1 MB body limit in code (do not rely on runtime defaults); call `guard` on each URL; run the pool-of-3 fetcher calls; return `{ judgements: Judgement[] }` as JSON. For the `possessed` check, apply `similarity` to the first 64 KB of visible text. Return `{ error: string }` with 4xx on invalid input; never expose stack traces.
    - _Requirements: 6.1, 5_
  - [ ] 8.2 Register `POST /api/resolve` in `src/worker/index.ts`: accept `{ input: string, kind: 'url' | 'repo' }`; fetch the input page or GitHub README; detect content type; return `{ source: string, kind: 'markdown' | 'html' }` or `{ error: string }` with 422 when unresolvable.
    - _Requirements: 1.3, 1.4_
  - [ ] 8.3 Configure `wrangler.toml` with `[assets]` pointing to the Vite build output (`dist/`) and a build command that runs both the Vite build and the Worker bundle. Ensure no legacy `[site]` bucket is present.
    - _Requirements: 6_

- [ ] 9. Graveyard UI
  - [ ] 9.1 Create the page shell in `web/index.html` and `web/graveyard.ts`: input area for pasting text, URL, or `owner/repo`; sample-document button; apply palette and type from `.kiro/steering/costume.md` (ink `#0b0d12`, slate `#1c2230`, bone `#e8e2d0`, amber `#f2a541`, ectoplasm `#7dffb0`; one carved display face for headings; system sans for body; `tsconfig.web.json` with `DOM` lib).
    - _Requirements: 6.9_
  - [ ] 9.2 Implement extraction and batching in `web/graveyard.ts`: bundle `extract` from core (Vite tree-shakes the rest); for page-URL or repo inputs first call `POST /api/resolve`; apply the 200-link cap in the browser; send at most 3 URLs per `POST /api/scan`, at most 2 requests in flight; append returned `Judgement` objects to the state array; call both the scene and ledger render functions on each update.
    - _Requirements: 1.7, 6.1_
  - [ ] 9.3 Implement the SVG scene in `web/scene.ts`: one element per judgement in document order. Shapes: lit window (amber `#f2a541`) for `alive`, crumbling tombstone for `dead`, zombie hand with green glow (`#7dffb0`) for `possessed`, fog patch for `restless`. Each shape carries a visible text label (colour is not the only signal). Tombstone and zombie-hand height: `clamp(lifespanYears * 12, 40, 220)` px where `lifespanYears` = whole-year difference between `epitaph.first` and `epitaph.last`; use 40 px minimum when no Epitaph. `possessed` links display their Epitaph on the zombie-hand element. Moon advances one step per returned batch. Motion: 400–900 ms ease-out, nothing bounces.
    - _Requirements: 6.1, 6.2, 6.3_
  - [ ] 9.4 Write a property test for the tombstone height formula in `test/scene.prop.test.ts` using `arbLifespan()`.
    - **Property 11: Tombstone height formula** — for any `y ≥ 0`, `clamp(y * 12, 40, 220)` is in `[40, 220]`, equals 40 at `y === 0`, increases linearly until 220 at `y === 30`, stays 220 for all `y > 30`.
    - **Validates: Requirements 6.3**
  - [ ] 9.5 Implement the Resurrect action and ledger in `web/graveyard.ts`: ledger table with one row per link (URL, verdict label, reason, Resurrection URL linked, exclude checkbox); "download patched document" button calls `patch()` from core bundled by Vite and downloads via Blob URL. For `dead` and `possessed` links, expose a Resurrect button that opens `judgement.resurrection` in a new tab; if `resurrection` is absent, disable the button and label it "No archived version available".
    - _Requirements: 6.4, 6.5, 6.6, 4.5_
  - [ ] 9.6 Accessibility pass in `web/graveyard.ts` and `web/scene.ts`: every interactive control reachable by keyboard alone with visible focus indicator; results container uses one `aria-live="polite"` region with batched announcements; `@media (prefers-reduced-motion: reduce)` suppresses all animations; colour contrast bone on ink ≥ 4.5:1; sound off by default with a visible toggle.
    - _Requirements: 6.7, 6.8_

- [ ] 10. CLI
  - [ ] 10.1 Implement CLI entry in `src/cli/index.ts`. Parse `revenant <file|url> [--fix] [--json]`. Infer kind from argument (file → read + infer; `http(s)://` → `'url'`; `owner/repo` pattern → `'repo'`). Run `scan` with default `fetcher` and default `wayback`. Collect all `Judgement` objects from `ScanEvent` stream. Default: one line per non-`alive` link (URL, verdict, reason, resurrection or `—`); no output if all alive. Exit 1 if any `dead` or `possessed`; exit 0 otherwise.
    - _Requirements: 7.1, 7.2, 7.3_
  - [ ] 10.2 Add `--fix`: when input is a file path, overwrite in place with `patch()` output for `dead` and `possessed` links. When input is a URL: print error to stderr (JSON structure when `--json` also set) and exit 2.
    - _Requirements: 7.4, 7.5_
  - [ ] 10.3 Add `--json`: print single `CliOutput` JSON to stdout; suppress per-line format.
    - _Requirements: 7.6_
  - [ ] 10.4 Add `"bin": { "revenant": "./dist/cli/index.js" }` to `package.json` and add an esbuild (or Vite) build step producing the CLI bundle targeting Node.js.
    - _Requirements: 7.1_
  - [ ] 10.5 Write CLI tests in `test/cli.int.test.ts` using a temporary file and a fake `Fetcher` shim: default output with mixed verdicts including `possessed`; no output when all alive (exit 0); exit 1 on `dead`/`possessed`; `--fix` rewrites file (replaces both `dead` and `possessed` links); `--fix` on URL → error + exit 2; `--json` output shape; `--fix --json` on URL → JSON error.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

- [ ] 11. Checkpoint — all surfaces wired
  - Run `npm test` and `npm run check`. Confirm no failures and no type errors before the MCP step.

- [ ] 12. MCP server
  - [ ] 12.1 Implement the stdio MCP server in `src/mcp/index.ts` using `@modelcontextprotocol/sdk`. Register two tools:
    - `check_links(text | urls[])`: empty input → MCP error (not empty list); otherwise return one `Judgement` per distinct URL with 200-URL cap and safe-fetching rules (Requirement 8.1–8.2).
    - `resurrect(url, date?)`: return closest Snapshot URL; handle all four cases: snapshot found, only no-snapshot, only Wayback unreachable, both (Requirement 8.3).
    - _Requirements: 8.1, 8.2, 8.3, 8.4_
  - [ ] 12.2 Write MCP server tests in `test/mcp.int.test.ts` using fake `Fetcher` and fake `Wayback`: `check_links` with text, with URL list, with empty input (MCP error); `resurrect` for all four snapshot/reachability states.
    - _Requirements: 8.1, 8.2, 8.3_
  - [ ] 12.3 Add an esbuild build step for `src/mcp/index.ts` targeting Node.js and register the server in `.kiro/settings/mcp.json` with `"command": "node"` and `"args": ["./dist/mcp/index.js"]`.
    - _Requirements: 8.1_

- [ ] 13. Ship
  - [ ] 13.1 Deploy to Cloudflare Workers using `npm run deploy`. Verify the Worker URL is live and the Graveyard page loads.
    - _Requirements: 6_
  - [ ] 13.2 Run the sample document on the live Worker and confirm at least one result for each of the four verdicts (`alive`, `dead`, `possessed`, `restless`). Update the sample document if any verdict is missing.
    - _Requirements: 6.9_
  - [ ] 13.3 Write `README.md`: one-paragraph description, Graveyard screenshots showing all four verdicts, CLI usage examples (`revenant`, `--fix`, `--json`), MCP configuration instructions, local development instructions (`npm run dev`, `npm test`).
    - _Requirements: 6, 7, 8_

## Notes

- All property-based test tasks (2.4, 3.3, 4.4, 4.8, 5.3, 6.5, 6.6, 9.4) and the scan integration test (6.7) are **mandatory** — they are the correctness evidence for the project.
- `patch` is pure and performs no I/O. Idempotency (Property 3) holds because Wayback URLs in an already-patched document are judged `alive` on re-scan.
- The `Wayback` interface is injected into `scan` so the integration test can fake it without real network calls.
- The Resurrection URL is built from the CDX last-snapshot timestamp as `https://web.archive.org/web/{timestamp}/{url}` (no `id_`) so archived pages render with rewritten links. `getSnapshotText` uses `id_/` to get the raw body for similarity. No separate Availability API call is needed.
- The Worker enforces a 1 MB body limit in code (task 8.1), not via runtime defaults.
- UI code lives in `web/` (Vite build); the costume hook and steering match `web/**/*`. Do not put UI code in `src/worker/static/`.
- `visibleText` is in `src/core/visible-text.ts` (kebab-case filename).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1"] },
    { "id": 1, "tasks": ["2.2"] },
    { "id": 2, "tasks": ["2.3", "2.4"] },
    { "id": 3, "tasks": ["3.1", "4.1", "4.2", "4.5"] },
    { "id": 4, "tasks": ["3.2", "3.3", "4.3", "4.4", "4.6"] },
    { "id": 5, "tasks": ["4.7", "4.8", "5.1"] },
    { "id": 6, "tasks": ["5.2", "5.3", "6.1", "6.2"] },
    { "id": 7, "tasks": ["6.3", "6.4"] },
    { "id": 8, "tasks": ["6.5", "6.6", "6.7", "8.1"] },
    { "id": 9, "tasks": ["8.2", "8.3", "9.1"] },
    { "id": 10, "tasks": ["9.2", "9.3"] },
    { "id": 11, "tasks": ["9.4", "9.5"] },
    { "id": 12, "tasks": ["9.6", "10.1"] },
    { "id": 13, "tasks": ["10.2", "10.3"] },
    { "id": 14, "tasks": ["10.4", "10.5"] },
    { "id": 15, "tasks": ["12.1"] },
    { "id": 16, "tasks": ["12.2", "12.3"] },
    { "id": 17, "tasks": ["13.1"] },
    { "id": 18, "tasks": ["13.2"] },
    { "id": 19, "tasks": ["13.3"] }
  ]
}
```
