# Implementation Plan: Revenant

## Overview

Build Revenant as a TypeScript ESM monorepo targeting Cloudflare Workers (web + Worker) and Node.js (CLI + MCP). The implementation follows a **pure core, thin doors** architecture: `src/core/` holds all pure functions, `src/net/` holds all I/O, and the three doors (`src/worker/`, `src/cli/`, `src/mcp/`) only orchestrate and render. Tasks are ordered so each step builds directly on the previous ones, with no orphaned code.

## Tasks

- [ ] 1. Scaffold project structure and tooling
  - Create `package.json` with `"type": "module"`, scripts (`dev`, `build`, `test`, `deploy`), and dependencies: `hono`, `@cloudflare/workers-types`, `@modelcontextprotocol/sdk`; devDependencies: `typescript`, `vitest`, `fast-check`, `wrangler`, `esbuild`.
  - Create `tsconfig.json` with `"strict": true`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"target": "ES2022"`, `"lib": ["ES2022"]`, path aliases for `#core`, `#net`.
  - Create `wrangler.toml` with the Worker name `revenant`, `compatibility_date`, `[site]` bucket pointing to `dist/static`, and `[build]` command.
  - Create the full directory skeleton: `src/core/`, `src/net/`, `src/worker/static/`, `src/cli/`, `src/mcp/`, `test/`.
  - Add a `vitest.config.ts` configuring `fast-check` and separate include globs for `*.test.ts`, `*.prop.test.ts`, and `*.int.test.ts`.
  - _Requirements: 1, 2, 3, 4, 5, 6, 7, 8_

- [ ] 2. Core types and URL guard
  - [ ] 2.1 Write `src/core/types.ts` with the exact types from the design: `Verdict`, `Link`, `Probe`, `Epitaph`, `Judgement`, `Fetcher`.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2_
  - [ ] 2.2 Implement `guard(url: string)` in `src/core/guard.ts`: return `{ ok: false, reason }` when scheme is not `http`/`https`, URL contains userinfo, host is an IPv4 literal in 10/8, 172.16/12, 192.168/16, 127/8, or 169.254/16, host is an IPv6 literal matching `::1` or `fc00::/7`, hostname is exactly `localhost`, or ends in `.local`, `.internal`, or `.localhost`; otherwise return `{ ok: true }`.
    - _Requirements: 5.1_
  - [ ]* 2.3 Write unit tests for `guard` in `test/guard.test.ts` covering each blocked IP range, each blocked hostname pattern, each scheme variant (`ftp:`, `mailto:`, `http:`, `https:`), and a URL with credentials.
    - _Requirements: 5.1_
  - [ ]* 2.4 Write property test for `guard` in `test/guard.prop.test.ts` using the `arbUrl()` generator.
    - **Property 7: The guard holds** — for any URL with a blocked host, scheme, or credentials, `guard` returns `ok: false` with a non-empty reason.
    - **Validates: Requirements 5.1**

- [ ] 3. Link extraction
  - [ ] 3.1 Implement `extract(source: string, kind: 'markdown' | 'html'): Link[]` in `src/core/extract.ts`.
    - For `markdown`: parse inline links `[text](url)`, reference links `[text][id]` with `[id]: url` definitions, autolinks `<url>`, and bare URLs (tokens starting with `http://` or `https://` not enclosed in `<>` or `[]()`). Record the byte `start`/`end` span of the URL portion within the source string for every occurrence.
    - For `html`: extract the `href` attribute value from every `<a>` element.
    - Exclude any URL found inside a fenced code block (`` ``` `` or `~~~` delimiters) before adding it to the result.
    - Exclude URLs whose scheme is not `http` or `https` (including `mailto:`, `#`-only, relative paths).
    - Deduplicate by exact URL string; a single `Link` carries all spans in first-encounter order.
    - _Requirements: 1.1, 1.2, 1.5, 1.6_
  - [ ]* 3.2 Write unit tests for `extract` in `test/extract.test.ts`: inline links, reference links, autolinks, bare URLs, fenced-block exclusion, duplicate-URL deduplication, `mailto:` exclusion, HTML `href` extraction, and mixed content.
    - _Requirements: 1.1, 1.2, 1.5, 1.6_
  - [ ]* 3.3 Write property test for `extract` in `test/extract.prop.test.ts` using `arbMarkdownSource(urls)` and `arbHtmlSource(urls)` generators.
    - **Property 4: Extraction round-trips** — for any Markdown or HTML source built from a known URL list, `extract` returns exactly those URLs (minus any wrapped in generated fenced blocks), and `source.slice(span.start, span.end)` equals the URL string for every span.
    - **Property 9: Deduplication invariant** — for any source containing the same URL at multiple locations, `extract` returns exactly one `Link` for that URL with a span count equal to the number of occurrences.
    - **Validates: Requirements 1.1, 1.2, 1.5, 1.6**

- [ ] 4. Similarity, visible text, and verdict classification
  - [ ] 4.1 Implement `visibleText(html: string): string` in `src/core/visibleText.ts` using a hand-written tokenizer (no DOM dependency) that strips all tags and removes `<script>` and `<style>` block content.
    - _Requirements: 2.5_
  - [ ] 4.2 Implement `similarity(a: string, b: string): number` in `src/core/similarity.ts` as the Jaccard index over 3-word shingles. Must return a value in `[0, 1]`; return `0` for empty strings; result must be symmetric.
    - _Requirements: 2.5_
  - [ ]* 4.3 Write unit tests for `similarity` in `test/similarity.test.ts` using the calibration examples from `docs/brief/calibration.md` (paul graham ~1.0, kiko.com ~0.0, HN ~0.13) plus the empty-string and identical-string edge cases.
    - _Requirements: 2.5_
  - [ ]* 4.4 Write property test for `similarity` in `test/similarity.prop.test.ts`.
    - **Property 5: Similarity is a proper measure** — for any strings `a` and `b`, `similarity(a, b)` is in `[0, 1]`; `similarity(a, a) === 1` for any non-empty `a`; `similarity(a, b) === similarity(b, a)`.
    - **Validates: Requirements 2.5**
  - [ ] 4.5 Implement the registrable-domain helper in `src/core/domain.ts`: return the last two hostname labels, treating `co.uk`, `com.au`, `org.uk`, `net.au`, `co.nz`, `org.nz`, `com.br`, `co.jp` as two-label effective TLDs.
    - _Requirements: 2.5, 2.8_
  - [ ] 4.6 Implement `classify(probe: Probe, originalUrl: string, snapshotText?: string): { verdict: Verdict; reason: string }` in `src/core/classify.ts` following the decision table from the design exactly (top-to-bottom, first match wins): `timeout` → `restless`; `network-error` → `dead`; 401/403/429 → `restless`; 404/410 → `dead`; 5xx → `dead`; 2xx + different registrable domain + snapshotText + similarity < 0.2 → `possessed`; 2xx + different domain + no snapshotText → `alive` with redirect reason; 2xx → `alive`. Never set `possessed` when `finalUrl` shares the same registrable domain as `originalUrl`.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_
  - [ ]* 4.7 Write unit tests for `classify` in `test/classify.test.ts` with one recorded `Probe` fixture per row in the decision table: DNS failure, 404, 410, 5xx, 401, 403, 429, timeout, 2xx same domain, 2xx cross-domain with low similarity, 2xx cross-domain with no snapshot, 2xx cross-domain with high similarity.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_
  - [ ]* 4.8 Write property test for `classify` in `test/classify.prop.test.ts` using the `arbProbe()` generator.
    - **Property 6: Never cry wolf** — for any `Probe` with status 401/403/429, `classify` never returns `dead`; for any `Probe` with `outcome === 'timeout'`, never returns `dead`; for any `Probe` whose `finalUrl` shares the same registrable domain as `originalUrl`, never returns `possessed`; every result has exactly one verdict and a non-empty reason string.
    - **Validates: Requirements 2.3, 2.4, 2.8, 2.9**

- [ ] 5. Document patching
  - [ ] 5.1 Implement `patch(source: string, judgements: Judgement[], excluded: Set<string>): string` in `src/core/patch.ts`. Collect all replacement spans for `dead` links that have a `resurrection` and are not in `excluded`. Sort spans by `start` descending. Apply substitutions right-to-left, replacing only the bytes within each `link.spans[i].start` to `link.spans[i].end`. Copy all other bytes verbatim. Leave `alive`, `restless`, `dead`-without-resurrection, and excluded links unchanged.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [ ]* 5.2 Write unit tests for `patch` in `test/patch.test.ts`: single replacement, multiple replacements, excluded links left unchanged, no dead links (source returned unchanged), right-to-left ordering correctness with overlapping offsets.
    - _Requirements: 4.1, 4.2, 4.3, 4.5_
  - [ ]* 5.3 Write property tests for `patch` in `test/patch.prop.test.ts` using `arbMarkdownSource` and `arbJudgements(links)` generators.
    - **Property 1: Patch touches only link targets** — removing all link-span byte ranges from both `source` and `patch(source, judgements, excluded)` yields identical strings.
    - **Property 2: The living are left alone** — when every judgement is `alive` or `restless`, `patch` returns a string byte-for-byte equal to `source`.
    - **Property 3: Patch is idempotent** — applying `patch` twice (re-extracting links from the already-patched output and treating Wayback URLs as `alive`) yields the same result as applying once.
    - **Property 8: Excluded links survive unchanged** — for any `dead` judgement with a resurrection in the excluded set, the original URL bytes appear unchanged in the output.
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5**

- [ ] 6. Network layer: fetcher, Wayback client, and scan orchestrator
  - [ ] 6.1 Implement the default `fetcher` in `src/net/fetcher.ts`. Follow redirects manually (call `guard()` on each redirect target before following; reject after 5 redirects with `network-error`). Apply an independent 8-second timeout, returning `Probe { outcome: 'timeout' }` on expiry. Read at most 512 KB of the response body; if exceeded, discard the body and report a body-size error in the `Probe`; when both timeout and body-size error occur simultaneously, report both.
    - _Requirements: 5.2, 5.3_
  - [ ] 6.2 Implement the Wayback Machine client in `src/net/wayback.ts` with three functions: `getEpitaph(url)` calling the CDX API for earliest and most-recent snapshots, `getResurrection(url)` calling the Availability API, and `getSnapshotText(url)` fetching the raw snapshot HTML and converting it via `visibleText`. Cache all responses for 24 hours (platform Cache API in Worker context; in-memory `Map` keyed by URL in CLI/MCP context). On 429, wait for `Retry-After` (capped at 10 s) and retry once; on second failure set Epitaph to `'unavailable'`. On connection error, HTTP error, or no response within 10 s, retain existing verdict and set Epitaph to `'unavailable'`.
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [ ] 6.3 Implement `scan(input, kind, fetcher, now)` as an async generator in `src/net/scan.ts`. Step-by-step: (1) Resolve input — if `kind` is `'url'`, fetch the page and detect `Content-Type` for effective parse kind; if `kind` is `'repo'`, fetch the default-branch README from the GitHub API; on failure yield an error and halt. (2) Call `extract`. (3) If more than 200 distinct URLs, keep the first 200 and emit a `meta` event with `{ total, capped: true }`; otherwise emit `{ total, capped: false }`. (4) Call `guard()` on each link; failing links yield `Judgement { verdict: 'restless', reason }` immediately with no network call. (5) Process remaining links with a concurrency pool of exactly 6; for each: call `fetcher` with `{ timeoutMs: 8000, maxBytes: 524288 }`; if 5xx, wait 2 s and retry once; if 2xx with a different registrable domain, fetch Wayback snapshot text; call `classify`; if verdict is `dead` or `possessed`, query CDX for Epitaph and Availability API for Resurrection; yield the completed `Judgement`.
    - _Requirements: 1.3, 1.4, 1.6, 1.7, 2.2, 5.4_
  - [ ]* 6.4 Write unit tests for the Wayback client in `test/wayback.test.ts` using fixture responses: CDX success, Availability success, snapshot text fetch, 429 back-off (honour Retry-After), CDX unreachable (Epitaph `'unavailable'`), Availability unreachable.
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [ ]* 6.5 Write a property test for the concurrency pool in `test/scan.prop.test.ts` using an instrumented fake `Fetcher`.
    - **Property 10: Concurrency cap invariant** — for any scan over more than 6 URLs, the number of in-flight concurrent `fetcher` calls never exceeds 6 at any point.
    - **Validates: Requirements 5.4**
  - [ ]* 6.6 Write a property test for the deduplication invariant at the scan level in `test/scan.prop.test.ts`.
    - **Property 9: Deduplication invariant** — for any source containing a URL more than once, `scan` checks that URL exactly once (single `fetcher` call) and reports all source locations.
    - **Validates: Requirements 1.6**
  - [ ]* 6.7 Write an integration test for `scan` in `test/scan.int.test.ts` using a fake `Fetcher` (no real network) over a 10-link document. The fake simulates: DNS failure (→ `dead`), 404 (→ `dead`), 5xx with successful retry (→ `alive`), 5xx with failed retry (→ `dead`), 403 (→ `restless`), timeout (→ `restless`), 2xx same-domain redirect (→ `alive`), 2xx cross-domain redirect with low-similarity snapshot (→ `possessed`).
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2_

- [ ] 7. Checkpoint — core and network complete
  - Ensure all tests pass (`vitest --run`). Verify the type-checker reports no errors (`tsc --noEmit`). Ask the user if any questions arise before continuing to the UI.

- [ ] 8. Worker HTTP API
  - [ ] 8.1 Create the Hono application in `src/worker/index.ts`. Register `POST /api/scan` with a 1 MB body limit enforced by the Worker runtime. Parse the JSON body `{ source, kind }`. Stream the response as `Content-Type: text/event-stream` by piping the `scan` async generator: write `event: meta\ndata: {...}\n\n` before the first judgement, `event: judgement\ndata: {...}\n\n` per judgement, and `event: done\ndata: \n\n` at the end. Return `{ error: string }` JSON with appropriate 4xx status for invalid input; never expose stack traces.
    - _Requirements: 6.1, 5_
  - [ ] 8.2 Configure `wrangler.toml` to serve `dist/static` as static assets alongside the Worker and add an `esbuild` build step that bundles `src/worker/index.ts` into the Worker entry point.
    - _Requirements: 6.1_

- [ ] 9. Graveyard UI
  - [ ] 9.1 Create the page shell in `src/worker/static/index.html` and `src/worker/static/graveyard.ts`: input area accepting pasted text, URL, or `owner/repo`; a sample-document button (single-activation, pre-supplied document, triggers scan on click); connect the submit action to `POST /api/scan`; apply the visual palette and type from `docs/brief/design-brief.md`.
    - _Requirements: 6.9_
  - [ ] 9.2 Implement the SSE client in `src/worker/static/graveyard.ts`: open an `EventSource`-equivalent against the streaming response, append each received `Judgement` to a state array, and render the ledger table synchronously on each update. The ledger shows URL, verdict label, reason, Resurrection URL (linked), and an exclude checkbox per row. Include a "download patched document" button that calls `patch()` (bundled from core) and triggers a `Blob` URL download.
    - _Requirements: 6.1, 6.2, 6.6, 4.5_
  - [ ] 9.3 Implement the SVG scene in `src/worker/static/scene.ts`: render one tombstone SVG element per judgement in document order along the x-axis. Shapes: crumbling tombstone for `dead`, upright tombstone for `alive`, leaning tombstone for `possessed` or `restless`. Each shape carries a visible text label matching the status name (colour is not the only differentiating signal). Tombstone height: `clamp(lifespanYears * 12, 40, 220)` px where `lifespanYears` is the whole-year difference between `epitaph.first` and `epitaph.last`; use minimum 40 px for a `dead` link with no Epitaph. Advance the moon icon one step per received result.
    - _Requirements: 6.1, 6.2, 6.3_
  - [ ]* 9.4 Write a property test for the tombstone height formula in `test/scene.prop.test.ts` using the `arbLifespan()` generator.
    - **Property 11: Tombstone height formula** — for any `y ≥ 0`, `clamp(y * 12, 40, 220)` is in `[40, 220]`, equals 40 at `y === 0`, increases linearly until 220 at `y === 30`, and stays 220 for all `y > 30`.
    - **Validates: Requirements 6.3**
  - [ ] 9.5 Implement the Resurrect action: each `dead` or `possessed` tombstone/row exposes a "Resurrect" button that opens `judgement.resurrection` in a new browser tab. If `resurrection` is absent, disable the button and label it "No archived version available".
    - _Requirements: 6.4, 6.5_
  - [ ] 9.6 Accessibility pass: ensure every interactive control is reachable by keyboard alone (logical tab order, visible focus indicator). Wrap the results container in an `aria-live="polite"` region so each new result is announced by screen readers. When `prefers-reduced-motion` is active, suppress all animations (rising, drifting, fading, pulsing) via a `@media (prefers-reduced-motion: reduce)` CSS block. Verify colour contrast meets WCAG AA.
    - _Requirements: 6.7, 6.8_

- [ ] 10. CLI
  - [ ] 10.1 Implement the CLI entry point in `src/cli/index.ts`. Parse `revenant <file|url> [--fix] [--json]` using `process.argv`. If the argument is a file path, read it and pass to `scan` with the inferred kind; if it starts with `http://` or `https://`, pass as `kind: 'url'`; if it matches `owner/repo`, pass as `kind: 'repo'`. Collect all `Judgement` objects. Default output: print one line per non-`alive` link to stdout in the format `<url>  <verdict>  <reason>  <resurrection|none>`. If all links are `alive`, print nothing. Exit 1 if any link is `dead` or `possessed`; exit 0 otherwise.
    - _Requirements: 7.1, 7.2, 7.3_
  - [ ] 10.2 Add `--fix` support: when provided and the input is a file path, overwrite the file in place with the output of `patch()`. When provided and the input is a URL, print an error to stderr (`{ error }` JSON when `--json` is also set) and exit 2.
    - _Requirements: 7.4, 7.5_
  - [ ] 10.3 Add `--json` support: when provided, print a single JSON structure to stdout matching the `CliOutput` type (every link with `url`, `verdict`, `reason`, `resurrection?`, `epitaph?`, `spans`) and suppress the per-line format.
    - _Requirements: 7.6_
  - [ ] 10.4 Add a `"bin": { "revenant": "./dist/cli/index.js" }` entry in `package.json` and add an `esbuild` build step that produces the CLI bundle targeting Node.js.
    - _Requirements: 7.1_
  - [ ]* 10.5 Write CLI tests in `test/cli.int.test.ts` using a temporary file and a fake `Fetcher` shim. Cover: default output with mixed verdicts, no output when all alive (exit 0), exit code 1 on dead/possessed, `--fix` rewrites file, `--fix` on URL prints error and exits 2, `--json` output shape, `--fix --json` on URL emits JSON error.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

- [ ] 11. Checkpoint — all surfaces wired
  - Run `vitest --run` and `tsc --noEmit`. Confirm no test failures and no type errors. Ask the user if any questions arise before the MCP step.

- [ ] 12. MCP server
  - [ ] 12.1 Implement the stdio MCP server in `src/mcp/index.ts` using `@modelcontextprotocol/sdk`. Register two tools:
    - `check_links(text | urls[])`: if the input contains no URLs or the list is empty, return an MCP error response (not an empty list); otherwise return one `Judgement` per distinct URL applying the same 200-URL cap (`meta` event) and safe-fetching rules as the web application. Call `guard()` on every URL and produce `restless` with the rejection reason for any that fail.
    - `resurrect(url, date?)`: return the Wayback snapshot closest to `date`, or the most recent if no date is given; handle the four cases exactly as specified in Requirement 8.3 (snapshot + unreachable, only no-snapshot, only unreachable, both).
    - _Requirements: 8.1, 8.2, 8.3, 8.4_
  - [ ]* 12.2 Write MCP server tests in `test/mcp.int.test.ts` using fake `Fetcher` and Wayback client. Cover: `check_links` with pasted text (URLs extracted), `check_links` with explicit URL list, `check_links` with empty input (MCP error), `resurrect` with snapshot found, `resurrect` with no snapshot, `resurrect` with Wayback unreachable, `resurrect` with both no-snapshot and unreachable.
    - _Requirements: 8.1, 8.2, 8.3_
  - [ ] 12.3 Add an `esbuild` build step for `src/mcp/index.ts` targeting Node.js and register the MCP server in `.kiro/settings/mcp.json` with `"command": "node"` and `"args": ["./dist/mcp/index.js"]` so Kiro can use it.
    - _Requirements: 8.1_

- [ ] 13. Ship
  - [ ] 13.1 Deploy to Cloudflare Workers using `wrangler deploy`. Verify the Worker URL is live and the Graveyard page loads.
    - _Requirements: 6_
  - [ ] 13.2 Run the sample document on the live Worker and confirm the scan produces at least one result for each of the four verdicts (`alive`, `dead`, `possessed`, `restless`). Update the sample document if any verdict is missing.
    - _Requirements: 6.9_
  - [ ] 13.3 Write `README.md` at the repository root with: a one-paragraph description of Revenant, screenshots of the Graveyard showing each verdict, CLI usage examples (`revenant`, `--fix`, `--json`), MCP configuration instructions, and local development instructions (`npm run dev`, `npm test`).
    - _Requirements: 6, 7, 8_

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP.
- Each task references specific requirements for traceability.
- Checkpoints (tasks 7 and 11) validate incremental progress before moving to the next surface.
- Property tests validate universal correctness invariants; unit tests validate specific examples and edge cases.
- The `Fetcher` type is injected as a dependency throughout; never import `fetcher` directly in `src/core/` or in tests.
- The Worker build, CLI build, and MCP build are three separate `esbuild` invocations; all share `src/core/` and `src/net/` without modification.

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
    { "id": 9, "tasks": ["8.2", "9.1"] },
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
