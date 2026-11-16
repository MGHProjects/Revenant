# Design Document: Revenant

## Overview

Revenant is a link-rot checker and document patcher. It scans Markdown, HTML, or remote documents, assigns a trustworthy verdict to every absolute HTTP/HTTPS link it finds, retrieves archived copies of dead or hijacked links from the Wayback Machine, and produces a patched document with broken links replaced. It is exposed through three surfaces: a streaming web UI (the Graveyard), a CLI for CI pipelines, and an MCP server for AI agent use.

The central design principle is a **pure core with thin doors**: all logic lives in pure functions under `src/core/`; network I/O lives in `src/net/`; and the three doors (Worker, CLI, MCP) only feed the core and render its output. The `Fetcher` type is an injected dependency so the core has zero I/O coupling, making every core function fast and deterministic to test.

## Architecture

```
 web ──batch JSON──▶ worker ─┐
 cli ───────────────────────┼─▶ scan(input, fetcher, wayback, now) ─▶ net ─▶ internet
 mcp ───────────────────────┘            │
                                         └─▶ core (extract, guard, classify, similarity, patch)
```

**Layers:**

| Layer | Location | Responsibility |
|---|---|---|
| Core | `src/core/` | Pure functions only: `extract`, `guard`, `similarity`, `classify`, `patch`, `visible-text` |
| Net | `src/net/` | Stateful I/O: `fetcher`, Wayback client, `scan` async generator |
| Worker | `src/worker/` | Cloudflare Worker: `POST /api/scan` (JSON, 3-URL batches), `POST /api/resolve`, static asset serving |
| Web | `web/` | Vite + vanilla TypeScript: Graveyard UI, extract logic, batch orchestration |
| CLI | `src/cli/` | Node.js entry point: argument parsing, file I/O, process exit |
| MCP | `src/mcp/` | stdio MCP server: `check_links` and `resurrect` tools |

The Worker runs on the Cloudflare free plan (50 subrequests, 10 ms CPU per request). The web page runs `extract` itself (core is pure and bundled by Vite) and owns the 200-link cap. The browser sends at most 3 URLs per request and 2 requests in flight. The CLI and MCP server run on Node.js with no such limits and use `scan` with a full pool of 6 directly.

## Components and Interfaces

### Core Types (`src/core/types.ts`)

```ts
type Verdict = 'alive' | 'dead' | 'possessed' | 'restless';

interface Link {
  url: string;
  spans: Array<{ start: number; end: number }>;
}

interface Probe {                       // what the network saw; input to classify()
  outcome: 'response' | 'network-error' | 'timeout';
  status?: number;
  finalUrl?: string;
  text?: string;
}

interface Epitaph { first: string; last: string }   // ISO dates

interface Judgement {
  link: Link;
  verdict: Verdict;
  reason: string;
  epitaph?: Epitaph | 'unavailable';
  resurrection?: string;               // snapshot URL
}

type Fetcher = (
  url: string,
  init?: { timeoutMs: number; maxBytes: number }
) => Promise<Probe>;

// Wayback client interface — injected so tests can fake it
interface Wayback {
  getEpitaph(url: string): Promise<Epitaph | 'unavailable'>;
  getResurrection(url: string): Promise<string | undefined>;
  getSnapshotText(url: string): Promise<string | undefined>;
}

// Scan event union — all events yielded by scan()
type ScanEvent =
  | { type: 'meta'; total: number; capped: boolean; capLimit: 200 }
  | { type: 'judgement'; judgement: Judgement }
  | { type: 'error'; message: string };
```

### Core Functions (`src/core/`)

All functions in this module are **pure**: no `fetch`, no `Date.now()`, no globals.

#### `extract(source: string, kind: 'markdown' | 'html') → Link[]`

Parses the source text and returns one `Link` per distinct URL. Each `Link` carries every byte span at which the URL appears in `source`.

For **Markdown**, recognises:
- Inline links: `[text](url)`
- Reference links: `[text][id]` with a `[id]: url` definition elsewhere in the source
- Autolinks: `<url>`
- Bare URLs: tokens starting with `http://` or `https://` not enclosed in `<>` or `[]()`

For **HTML**, extracts the `href` attribute from every `<a>` element.

Exclusion rules:
- URLs inside fenced code blocks (delimited by ` ``` ` or `~~~`) are excluded.
- URLs whose scheme is not `http` or `https` are excluded.

Deduplication is by exact URL string. When the same URL appears at multiple locations, a single `Link` is returned with all spans in encounter order.

#### `guard(url: string) → { ok: true } | { ok: false; reason: string }`

Validates a URL against Requirement 5.1. Rejects when any of the following hold:

- Scheme is not `http` or `https`
- URL contains a userinfo (credentials) component
- Host is an IP literal in **any form**: dotted-decimal, hex, octal, integer notation, IPv4-mapped IPv6 (`::ffff:...`), link-local IPv6 (`fe80::/10`), loopback IPv6 (`::1`), ULA (`fc00::/7`), CGNAT (`100.64.0.0/10`), or any private/loopback IPv4 range (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0.0.0.0/8)
- Hostname is exactly `localhost`, or ends in `.local`, `.internal`, or `.localhost`

A Worker cannot perform DNS resolution; the guard operates on the literal host string in the URL.

#### `similarity(a: string, b: string) → number`

Jaccard index over 3-word shingles of the two strings. Returns a value in `[0, 1]`. Empty strings return `0`. Symmetric: `similarity(a, b) === similarity(b, a)`.

For the Worker, similarity is computed over the first 64 KB of visible text of each side to stay within the 10 ms CPU limit. This cap is raised if the Worker moves to the paid plan.

#### `visible-text(html: string) → string`  (`src/core/visible-text.ts`)

Strips tags, `<script>` blocks, and `<style>` blocks from an HTML string using a small hand-written tokenizer. No DOM dependency.

#### Registrable-domain computation

Used by `classify` to determine whether a redirect crosses domain boundaries. The registrable domain is the last two labels of the hostname, with these two-level suffixes treated as the effective TLD: `co.uk`, `com.au`, `org.uk`, `net.au`, `co.nz`, `org.nz`, `com.br`, `co.jp`. Switch to the full Public Suffix List if a false `possessed` verdict is traced to this shortcut.

#### `classify(probe: Probe, originalUrl: string, snapshotText?: string) → { verdict: Verdict; reason: string }`

Decision table, evaluated top to bottom; first match wins:

| Condition | Verdict | Reason format |
|---|---|---|
| `outcome === 'timeout'` | `restless` | `timed out after 8 s` |
| `outcome === 'network-error'` | `dead` | connection error message |
| `status` is 401, 403, or 429 | `restless` | `{status} {statusText}` |
| `status` is 404 or 410 | `dead` | `{status} {statusText}` |
| `status` is 5xx (after retry) | `restless` | `{status} after retry` |
| `status` is 2xx AND `finalUrl` has a **different** registrable domain AND `snapshotText` provided AND `similarity(probe.text, snapshotText) < 0.2` | `possessed` | `content {score}% similar to {year} capture` |
| `status` is 2xx AND `finalUrl` has a **different** registrable domain AND `snapshotText` absent | `alive` | `redirected to {newDomain}` |
| `status` is 2xx | `alive` | `{status} OK` |

The `possessed` path is **never** taken when `finalUrl` shares the same registrable domain as `originalUrl` (see `docs/brief/calibration.md`).

#### `patch(source: string, judgements: Judgement[], excluded: Set<string>) → string`

Builds a new string from `source` by replacing URL spans for `dead` or `possessed` links that have a `resurrection` and are not in `excluded`. All other bytes are copied verbatim.

The replacement strategy: collect all replacement spans, sort by `start` descending, apply substitutions right-to-left so earlier offsets remain valid after each replacement. Only bytes within `link.spans[i].start` to `link.spans[i].end` are modified.

Links with verdict `alive` or `restless`, `dead` or `possessed` links with no `resurrection`, and any link in `excluded` are left unchanged.

`patch` is **pure**: it performs no I/O and makes no network calls. Idempotency (Requirement 4.4) is achieved by the fact that when the already-patched document is re-scanned, the Wayback URLs in it will be judged `alive`, causing `patch` to leave them unchanged.

### Net Layer (`src/net/`)

#### `fetcher` — default `Fetcher` implementation

The concrete network function injected into all doors. The core never imports it.

- **Redirect handling**: follows redirects manually, calling `guard()` on each redirect target before following it. Rejects after 5 redirects with a `network-error` Probe.
- **Timeout**: 8-second deadline; returns `Probe { outcome: 'timeout' }` on expiry.
- **Body size**: reads at most 512 KB. If the body exceeds that limit, reading stops and the truncated body is used as the full response (the request is **not** treated as an error).
- **5xx retry**: the `scan` orchestrator (not the fetcher) retries once after 2 seconds when the first response is 5xx.

#### Wayback Machine client (`src/net/wayback.ts`) — implements `Wayback`

The `Wayback` interface is injected into `scan`, enabling the integration test to fake it without real network calls.

Three Wayback APIs are used:

| Purpose | Endpoint |
|---|---|
| Epitaph first snapshot | `https://web.archive.org/cdx/search/cdx?url={u}&output=json&fl=timestamp,statuscode&filter=statuscode:200&limit=1` |
| Epitaph last snapshot | `https://web.archive.org/cdx/search/cdx?url={u}&output=json&fl=timestamp,statuscode&filter=statuscode:200&limit=-1` |
| Resurrection URL | Built from CDX last timestamp: `https://web.archive.org/web/{timestamp}/{url}` — no third API call needed |
| Snapshot text for `possessed` check | `https://web.archive.org/web/{timestamp}id_/{url}` |

The Resurrection URL is derived from the CDX "last" timestamp already fetched for the Epitaph, avoiding a separate call to the Availability API.

**Caching**: all Wayback responses are cached for 24 hours. In the Worker the platform Cache API is used; in the CLI and MCP server an in-memory `Map` keyed by URL is used. Cache entry shape:

```ts
interface WaybackCacheEntry {
  epitaph?: Epitaph | 'unavailable';
  resurrection?: string;
  snapshotText?: string;
  cachedAt: number;
  ttlMs: 86_400_000;
}
```

**429 back-off**: wait for the `Retry-After` header value (capped at 10 s), retry once; on second failure set Epitaph to `'unavailable'`.

**Unreachable / timeout**: on connection error, HTTP error response, or no response within 10 s, retain existing verdict and set Epitaph to `'unavailable'`.

#### `scan(input: string, kind: InputKind, fetcher: Fetcher, wayback: Wayback, now: Date)` — async generator

```ts
type InputKind = 'markdown' | 'html' | 'url' | 'repo';
```

Yields `ScanEvent` objects. Used by CLI and MCP only (the Worker uses per-batch calls instead of the full generator).

The six steps:

1. **Resolve input**: if `kind` is `'url'`, fetch the page and detect `Content-Type` for effective parse kind. If `kind` is `'repo'`, fetch the default-branch README from the GitHub API as Markdown. On failure or undetectable content type: yield `{ type: 'error', message }` and halt.
2. **Extract**: call `extract(source, effectiveKind)` → `Link[]`.
3. **Cap**: if more than 200 distinct URLs, keep the first 200 and emit `{ type: 'meta', total: actualCount, capped: true, capLimit: 200 }`. Otherwise emit `{ type: 'meta', total: actualCount, capped: false, capLimit: 200 }`.
4. **Guard**: for each `Link`, call `guard(link.url)`. Failing links yield `{ type: 'judgement', judgement: { verdict: 'restless', reason } }` immediately.
5. **Pool of 6**: process remaining links with a concurrency pool of exactly 6. For each URL:
   - `fetcher(url, { timeoutMs: 8000, maxBytes: 524288 })` → `Probe`.
   - If 5xx: wait 2 s and call `fetcher` once more.
   - Only if 2xx AND `finalUrl` has a different registrable domain from `url`: call `wayback.getSnapshotText(url)`.
   - `classify(probe, url, snapshotText?)` → `{ verdict, reason }`.
   - If `dead` or `possessed`: call `wayback.getEpitaph(url)` → Epitaph; build Resurrection from CDX last timestamp.
   - Yield `{ type: 'judgement', judgement }`.
6. **Same-domain alive links** cost zero Wayback calls.

### Worker (`src/worker/`)

A Hono application running on the Cloudflare free plan (50 subrequests, 10 ms CPU per request). No SSE — responses are plain JSON.

**`POST /api/scan`**

- Request body: `{ urls: string[] }` — at most 3 URLs. Body size limit enforced in code (not relying on runtime defaults).
- Response: `{ judgements: Judgement[] }` as plain JSON.
- Errors: `{ error: string }` with appropriate 4xx status. Stack traces never exposed.
- Internally: calls `guard` on each URL, then runs `fetcher` with the pool-of-3 for this request (staying under 50 subrequests). For the `possessed` check, `similarity` is applied to the first 64 KB of visible text.

**`POST /api/resolve`**

- Request body: `{ input: string, kind: 'url' | 'repo' }`.
- Response: `{ source: string, kind: 'markdown' | 'html' }` — the fetched and content-typed source text.
- Errors: `{ error: string }` with 422 when input cannot be fetched or content type is undetectable.
- Used by the browser before it starts batching, so the browser can run `extract` locally.

Static assets are served from `dist/` (the Vite build output). `wrangler.toml` uses `[assets]` (not the legacy `[site]` bucket).

### Web UI (`web/`)

Built with Vite + vanilla TypeScript + CSS. No UI framework. Graphics are inline SVG and CSS. The `web/` directory is what the costume hook and steering file match against.

**`tsconfig.json` for `web/`** includes `"lib": ["ES2022", "DOM"]`.

**Graveyard (`web/graveyard.ts`)** keeps one array of `Judgement` objects and renders it in two synchronised views.

**SVG scene** — one element per judgement in document order along the x-axis:

| Verdict | Visual element |
|---|---|
| `alive` | Lit window (warm amber `#f2a541`) |
| `dead` | Crumbling tombstone |
| `possessed` | Zombie hand with green glow (`#7dffb0`) |
| `restless` | Fog patch |

Each element carries a visible text label matching the status name. Colour is not the only differentiating signal (Requirement 6.2). Palette: ink `#0b0d12`, slate `#1c2230`, bone `#e8e2d0`, amber `#f2a541`, ectoplasm `#7dffb0`, blood `#c8323c` (errors only). Motion is 400–900 ms ease-out; things rise, nothing bounces.

Tombstone height: `clamp(lifespanYears * 12, 40, 220)` pixels (whole-year difference between Epitaph `first` and `last`). A `dead` link with no Epitaph uses minimum height 40 px. Maximum height is 220 px (reached at 30+ years).

The moon icon advances one step per batch received. Batching: the browser extracts links itself (core bundled by Vite), sends at most 3 URLs per `POST /api/scan`, and keeps at most 2 requests in flight. For page-URL or repo inputs, the browser first calls `POST /api/resolve` to get the source text.

**Ledger table** — one row per link: URL, verdict label, reason, Resurrection URL (linked), exclude checkbox. Includes a "download patched document" button that calls `patch()` (bundled from core) and downloads via Blob URL.

**Accessibility** (cannot be cut):
- Every interactive control reachable by keyboard alone; logical tab order; visible focus indicator.
- Results container wrapped in one `aria-live="polite"` region; announcements are batched, not one per link.
- `prefers-reduced-motion`: no animations (rising, drifting, fading, pulsing) via `@media (prefers-reduced-motion: reduce)`.
- Colour contrast ≥ 4.5:1 (bone on ink).
- Sound off by default with a visible toggle.

**Sample document**: a single-activation control loads a pre-supplied document and triggers a scan without user input.

### CLI (`src/cli/`)

Entry point: `revenant <file|url> [--fix] [--json]`

Reads a file or URL, runs `scan` with the default `fetcher` and default `wayback` (no free-plan limits on Node), collects all `Judgement` objects from the `ScanEvent` stream.

- Default: one line per non-`alive` link — URL, verdict, reason, Resurrection (or placeholder). No output if all alive. Exit 1 if any `dead` or `possessed`; exit 0 otherwise.
- `--fix`: overwrite file in place with `patch()` output for `dead` and `possessed` links. Error if input is a URL.
- `--json`: print `CliOutput` JSON; suppress per-line format. Error output is JSON when `--json` is set.

### MCP Server (`src/mcp/`)

stdio MCP server using `@modelcontextprotocol/sdk`. Runs on Node; uses full `scan` pool of 6.

**`check_links(text | urls[])`**: empty input → MCP error. Otherwise returns one `Judgement` per distinct URL with 200-URL cap and safe-fetching rules.

**`resurrect(url, date?)`**: returns closest Snapshot URL; handles all four states (snapshot found, not found, Wayback unreachable, both).

## Data Models

### Input resolution

| `kind` | Source | Effective parse kind |
|---|---|---|
| `'markdown'` | Provided string | `markdown` |
| `'html'` | Provided string | `html` |
| `'url'` | Fetched via `POST /api/resolve` (browser) or `scan` (CLI/MCP) | `markdown` or `html`; error if undetectable |
| `'repo'` | GitHub default-branch README | `markdown` |

### Worker API payloads

```ts
// POST /api/scan request
interface ScanRequest { urls: string[] }   // at most 3

// POST /api/scan response
interface ScanResponse { judgements: Judgement[] }

// POST /api/resolve request
interface ResolveRequest { input: string; kind: 'url' | 'repo' }

// POST /api/resolve response
interface ResolveResponse { source: string; kind: 'markdown' | 'html' }
```

### CLI JSON output (`--json`)

```ts
interface CliOutput {
  links: Array<{
    url: string;
    verdict: Verdict;
    reason: string;
    resurrection?: string;
    epitaph?: Epitaph | 'unavailable';
    spans: Array<{ start: number; end: number }>;
  }>;
}
```

## Correctness Properties

Each property is a fast-check test in `test/*.prop.test.ts`, minimum 100 iterations, tagged:

```ts
// Feature: revenant, Property N: <property title>
fc.assert(fc.property(...), { numRuns: 100 });
```

### Property 1: Patch touches only link targets

For any source string and any judgements, removing all link-span byte ranges from both `source` and `patch(source, judgements, excluded)` yields identical strings.

**Validates: Requirements 4.2**

### Property 2: The living are left alone

For any source string where every judgement is `alive` or `restless`, `patch(source, judgements, new Set())` returns a string byte-for-byte equal to `source`.

**Validates: Requirements 4.3**

### Property 3: Patch is idempotent

For any source string, applying `patch` twice — where the second pass re-extracts links from the already-patched output and treats all Wayback URLs as `alive` — produces the same result as applying `patch` once. `patch` is pure and performs no I/O; idempotency follows from the `alive` verdict on already-replaced Wayback URLs.

**Validates: Requirements 4.4**

### Property 4: Extraction round-trips

For any Markdown source built from a known list of URLs in any syntactic form (inline, reference, autolink, bare), `extract(source, 'markdown')` returns exactly those URLs (excluding any wrapped in generated fenced blocks), and `source.slice(span.start, span.end)` equals the URL string for every span.

The same round-trip holds for HTML `href` extraction.

**Validates: Requirements 1.1, 1.2, 1.5, 1.6**

### Property 5: Similarity is a proper measure

For any strings `a` and `b`: `similarity(a, b)` is in `[0, 1]`; `similarity(a, a) === 1` for any non-empty `a`; `similarity(a, b) === similarity(b, a)`.

**Validates: Requirements 2.5**

### Property 6: Never cry wolf

For any `Probe` with status 401, 403, or 429, `classify` never returns `dead`. For any `Probe` with `outcome === 'timeout'`, `classify` never returns `dead`. For any `Probe` with `status` 5xx (the after-retry path), `classify` returns `restless`, not `dead`. For any `Probe`, `classify` returns exactly one verdict and a non-empty reason. For any `Probe` whose `finalUrl` shares the same registrable domain as the requested URL, `classify` never returns `possessed`.

**Validates: Requirements 2.2, 2.3, 2.4, 2.8, 2.9**

### Property 7: The guard holds

For any URL whose host is an IP literal in any form (including hex, octal, integer, IPv4-mapped IPv6, link-local IPv6, CGNAT), `localhost`, or any blocked suffix, or whose scheme is not `http`/`https`, or that contains userinfo, `guard` returns `ok: false` with a non-empty reason.

**Validates: Requirements 5.1**

### Property 8: Excluded links survive the patch unchanged

For any source string, any set of `dead` or `possessed` judgements with resurrections, and any non-empty excluded set, the original URL bytes at every excluded link's spans appear unchanged in the output of `patch`.

**Validates: Requirements 4.5**

### Property 9: Deduplication invariant

For any Markdown or HTML source containing the same URL at multiple distinct locations, `extract` returns exactly one `Link` for that URL, and the number of spans equals the number of occurrences.

**Validates: Requirements 1.6**

### Property 10: Concurrency cap invariant

For any scan over more than 6 URLs (with a fake instrumented `Fetcher`), the number of in-flight concurrent `fetcher` calls never exceeds 6 at any point.

**Validates: Requirements 5.4**

### Property 11: Tombstone height formula

For any whole-year lifespan value `y ≥ 0`, `clamp(y * 12, 40, 220)` is in `[40, 220]`, equals 40 at `y === 0`, increases linearly until 220 at `y === 30`, and remains 220 for all `y > 30`.

**Validates: Requirements 6.3**

## Error Handling

| Failure | Behaviour |
|---|---|
| Input page or repo cannot be fetched, or content type undetectable | 422 `{ error }` from Worker; CLI stderr + exit 2; nothing scanned |
| Wayback unreachable or times out (10 s) | Verdict retained; Epitaph `'unavailable'`; UI shows "the archive is silent" |
| 429 from Wayback | Wait `Retry-After` (capped 10 s), retry once; on second failure Epitaph `'unavailable'` |
| URL rejected by `guard` | Verdict `restless` with rejection reason; no outbound request |
| Response body exceeds 512 KB | Reading stops at 512 KB; truncated body treated as full response; not an error |
| `--fix` on a URL input | Error to stderr (JSON when `--json` set); exit 2 |
| `check_links` with no URLs | MCP error response |
| Redirect target fails `guard` | Verdict `restless` with rejection reason |
| 5xx after retry | Verdict `restless` with `{status} after retry` reason |

## Testing Strategy

### Property-based tests (`test/*.prop.test.ts`)

Library: **fast-check**. Minimum 100 iterations per property.

Generators:

| Generator | Produces |
|---|---|
| `arbMarkdownSource(urls)` | Markdown with the given URLs in random syntactic forms; some optionally in fenced blocks |
| `arbHtmlSource(urls)` | HTML with `<a href>` elements for the given URLs |
| `arbProbe()` | `Probe` objects spanning all `outcome` and `status` combinations |
| `arbJudgements(links)` | `Judgement` arrays consistent with a given `Link[]` |
| `arbUrl()` | URLs covering edge cases: private IPs in all notations, blocked hostnames, non-http schemes, credentials, valid http/https |
| `arbLifespan()` | Non-negative integers (whole years) |

### Unit tests (`test/*.test.ts`)

- `classify`: one fixture per row in the decision table.
- `guard`: each IP range, hostname pattern, scheme variant, credentials.
- `patch`: single replacement, multiple, excluded, no dead links, right-to-left ordering.
- `extract`: all Markdown forms, fenced exclusion, deduplication, `mailto:`, HTML href.
- `similarity`: calibration examples from `docs/brief/calibration.md` (paul graham ~1.0, kiko.com ~0.0, HN ~0.13) plus edge cases.
- Wayback client: fixture responses for CDX, 429 back-off, unreachable.

### Integration tests (`test/*.int.test.ts`)

One `scan` integration test with a fake `Fetcher` and fake `Wayback` (no real network) over a 10-link document, covering all four verdicts. CLI and MCP server tested with fake shims for exit codes, output formats, and tool responses.

### Accessibility tests

One Playwright test: ARIA live-region announcements, keyboard navigation, sample document trigger, `prefers-reduced-motion` suppression.

### Manual verification

Before deployment, the sample document must produce at least one of each verdict on the live Worker.

## Out of Scope (v1)

Same-host drift detection (page replaced without a redirect), GitHub PR creation, user accounts, scheduled rescans, crawling beyond one page.

