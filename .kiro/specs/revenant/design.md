# Design Document: Revenant

## Overview

Revenant is a link-rot checker and document patcher. It scans Markdown, HTML, or remote documents, assigns a trustworthy verdict to every absolute HTTP/HTTPS link it finds, retrieves archived copies of dead or hijacked links from the Wayback Machine, and produces a patched document with broken links replaced by their archived copies. It is exposed through three surfaces: a streaming web UI (the Graveyard), a CLI for CI pipelines, and an MCP server for AI agent use.

The central design principle is a **pure core with thin doors**: all logic lives in pure functions under `src/core/`; network I/O lives in `src/net/`; and the three doors (Worker, CLI, MCP) only feed the core and render its output. The `Fetcher` type is an injected dependency so the core has zero I/O coupling, making every core function fast and deterministic to test.

## Architecture

```
 web ──SSE──▶ worker ─┐
 cli ─────────────────┼─▶ scan(input, fetcher, now) ─▶ net (fetcher, wayback) ─▶ internet
 mcp ─────────────────┘            │
                                   └─▶ core (extract, guard, classify, similarity, patch)
```

**Layers:**

| Layer | Location | Responsibility |
|---|---|---|
| Core | `src/core/` | Pure functions only: `extract`, `guard`, `similarity`, `classify`, `patch`, `visibleText` |
| Net | `src/net/` | Stateful I/O: `fetcher`, Wayback client, `scan` async generator |
| Worker | `src/worker/` | Cloudflare Worker: HTTP API, SSE streaming, static asset serving |
| CLI | `src/cli/` | Node.js entry point: argument parsing, file I/O, process exit |
| MCP | `src/mcp/` | stdio MCP server: `check_links` and `resurrect` tools |

The Worker is deployed to Cloudflare Workers. The CLI and MCP server run on Node.js. All three doors share `src/core/` and `src/net/` without modification.

## Components and Interfaces

### Core Types (`src/core/types.ts`)

The types below are used verbatim throughout the codebase.

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
```

### Core Functions (`src/core/`)

All functions in this module are **pure**: no I/O, no global state, no side effects.

#### `extract(source: string, kind: 'markdown' | 'html') → Link[]`

Parses the source text and returns one `Link` per distinct URL. Each `Link` carries every byte span at which the URL appears in `source`.

For **Markdown**, it recognises:
- Inline links: `[text](url)`
- Reference links: `[text][id]` with a `[id]: url` definition elsewhere in the source
- Autolinks: `<url>`
- Bare URLs: tokens starting with `http://` or `https://` not enclosed in `<>` or `[]()`

For **HTML**, it extracts the `href` attribute from every `<a>` element.

Exclusion rules (applied before any URL is added to the result):
- URLs inside fenced code blocks (delimited by ` ``` ` or `~~~`) are excluded.
- URLs whose scheme is not `http` or `https` — including `mailto:`, fragment-only references starting with `#`, and relative paths without a scheme — are excluded.

Deduplication is by exact URL string. When the same URL appears at multiple locations, a single `Link` is returned with all spans listed in encounter order. The result list preserves first-encounter order.

#### `guard(url: string) → { ok: true } | { ok: false; reason: string }`

Validates a URL against the safe-fetching rules of Requirement 5.1. Returns `ok: false` with a human-readable reason when any of the following hold:

- Scheme is not `http` or `https`
- URL contains a userinfo component (credentials in the authority)
- Resolved host is an IPv4 literal in: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, or 169.254.0.0/16
- Resolved host is an IPv6 literal matching ::1 or the fc00::/7 range
- Hostname is exactly `localhost`, or ends in `.local`, `.internal`, or `.localhost`

#### `similarity(a: string, b: string) → number`

Computes the Jaccard index over 3-word shingles of the two visible-text strings. Returns a value in `[0, 1]`. Empty strings return `0`. The result is symmetric: `similarity(a, b) === similarity(b, a)`.

#### `visibleText(html: string) → string`

Strips tags, `<script>` blocks, and `<style>` blocks from an HTML string using a small hand-written tokenizer. No DOM dependency. Used to produce the input for `similarity`.

#### Registrable-domain computation

Used by `classify` to determine whether a redirect crosses domain boundaries. The registrable domain is the last two labels of the hostname, with the following two-level suffixes treated as the effective TLD: `co.uk`, `com.au`, `org.uk`, `net.au`, `co.nz`, `org.nz`, `com.br`, `co.jp`. If a false `possessed` verdict is ever traced to this shortcut, the implementation switches to the full Public Suffix List.

#### `classify(probe: Probe, originalUrl: string, snapshotText?: string) → { verdict: Verdict; reason: string }`

Applies the verdict decision tree to a completed `Probe`. This is the heart of the system. Evaluated top to bottom; first match wins.

| Condition | Verdict | Reason format |
|---|---|---|
| `outcome === 'timeout'` | `restless` | `timed out after 8 s` |
| `outcome === 'network-error'` | `dead` | connection error message |
| `status` is 401, 403, or 429 | `restless` | `{status} {statusText}` |
| `status` is 404 or 410 | `dead` | `{status} {statusText}` |
| `status` is 5xx | `dead` | `{status} {statusText}` (always called after retry; `scan` handles the retry) |
| `status` is 2xx AND `finalUrl` has a **different** registrable domain AND `snapshotText` is provided AND `similarity(probe.text, snapshotText) < 0.2` | `possessed` | `content {score}% similar to {year} capture` |
| `status` is 2xx AND `finalUrl` has a **different** registrable domain AND `snapshotText` is absent | `alive` | `redirected to {newDomain}` |
| `status` is 2xx | `alive` | `{status} OK` |

The `possessed` path is **never** taken when `finalUrl` shares the same registrable domain as `originalUrl`. Same-host similarity cannot reliably separate content replacement from normal drift (see `docs/brief/calibration.md`).

#### `patch(source: string, judgements: Judgement[], excluded: Set<string>) → string`

Builds a new string from `source` by replacing URL spans for `dead` links that have a `resurrection` and are not in `excluded`. All other bytes are copied verbatim.

The replacement strategy: collect all replacement spans, sort by `start` descending, apply substitutions right-to-left so earlier offsets remain valid after each replacement. Only bytes within `link.spans[i].start` to `link.spans[i].end` are modified.

Links with verdict `alive` or `restless`, `dead` links with no `resurrection`, and any link whose URL is in `excluded` are left unchanged.

### Net Layer (`src/net/`)

#### `fetcher` — default `Fetcher` implementation

The concrete network function used by all three doors. It is injected as a dependency; the core never imports it directly.

- **Redirect handling**: follows redirects manually, calling `guard()` on each redirect target before following it. Rejects after 5 redirects with a network-error `Probe`.
- **Timeout**: independently applies an 8-second deadline. Returns `Probe { outcome: 'timeout' }` if no complete response arrives in time.
- **Body size**: reads at most 512 KB. If the body exceeds that limit, the body is discarded and a body-size error is flagged. When both timeout and body-size error occur simultaneously, both are reported.
- **5xx retry**: the `scan` orchestrator (not the fetcher) retries once after 2 seconds when the first response is 5xx.

#### Wayback Machine client (`src/net/wayback.ts`)

Three Wayback APIs are used:

| Purpose | Endpoint |
|---|---|
| Epitaph (first + last snapshot) | `https://web.archive.org/cdx/search/cdx` |
| Resurrection (most recent snapshot URL) | `https://archive.org/wayback/available` |
| Snapshot text for `possessed` check | `https://web.archive.org/web/{timestamp}/{url}` |

**Caching**: all Wayback responses are cached for 24 hours. In the Worker the platform Cache API is used; in the CLI and MCP server an in-memory `Map` keyed by URL is used.

**429 back-off**: wait for the `Retry-After` header value (capped at 10 seconds), then retry once. If the retry also fails, return Epitaph `'unavailable'`.

**Unreachable / timeout**: if the Wayback Machine returns a connection error, an HTTP error response, or no response within 10 seconds, retain the existing verdict and set Epitaph to `'unavailable'`.

#### `scan(input: string, kind: InputKind, fetcher: Fetcher, now: Date)` — async generator

```ts
type InputKind = 'markdown' | 'html' | 'url' | 'repo';
```

Yields `Judgement` objects as they complete. The six steps:

1. **Resolve input**: if `kind` is `'url'`, fetch the page and detect `Content-Type` to determine the effective parse kind (`markdown` or `html`). If the fetch fails, returns non-2xx, or the content type cannot be detected as Markdown or HTML, yield an error and halt — the undetectable content-type case is treated identically to a fetch failure. If `kind` is `'repo'`, fetch the default-branch README from the GitHub API as Markdown; on failure, yield an error and halt.
2. **Extract**: call `extract(source, effectiveKind)` to get `Link[]`.
3. **Cap**: if more than 200 distinct URLs are found, keep only the first 200 in encounter order and emit a `meta` event with `{ total: actualCount, capped: true }`. Otherwise emit `{ total: actualCount, capped: false }`.
4. **Guard**: for each `Link`, call `guard(link.url)`. Links that fail guard become a `Judgement` with verdict `restless` and the guard rejection reason. Yielded immediately with no network call.
5. **Pool of 6**: process the remaining links with a concurrency pool of exactly 6. For each URL:
   - `fetcher(url, { timeoutMs: 8000, maxBytes: 524288 })` → `Probe`.
   - If the probe returns 5xx: wait 2 seconds and call `fetcher` once more.
   - Only if the response is 2xx **and** `finalUrl` has a different registrable domain from `url`: fetch the last Wayback snapshot text for `url`.
   - `classify(probe, url, snapshotText?)` → `{ verdict, reason }`.
   - If verdict is `dead` or `possessed`: query the CDX API for Epitaph and the Availability API for Resurrection.
   - Yield the completed `Judgement`.
6. **Same-domain alive links** cost zero Wayback calls — the shortcut on step 5b ensures this.

### Worker (`src/worker/`)

A Hono application running on Cloudflare Workers.

**`POST /api/scan`**

- Request body: `{ source: string, kind: 'markdown' | 'html' | 'url' | 'repo' }` (JSON, 1 MB body limit enforced by the Worker runtime).
- Response: `Content-Type: text/event-stream` with three event types:
  - `event: meta` — `{ total: number, capped: boolean }` sent before the first judgement.
  - `event: judgement` — one per `Judgement`, serialized as JSON.
  - `event: done` — empty data, marks end of stream.
- Errors: `{ error: string }` JSON body with appropriate 4xx status. Stack traces are never exposed to clients.

Static assets (HTML, CSS, bundled client-side JS) are served alongside the Worker.

### Graveyard UI (`src/worker/static/graveyard.ts`)

The client-side page keeps one array of `Judgement` objects and renders it in two synchronised views.

**SVG scene** — graves rendered in document order along the x-axis:

| Verdict | Tombstone shape |
|---|---|
| `dead` | Crumbling tombstone |
| `alive` | Upright tombstone |
| `possessed` | Leaning tombstone |
| `restless` | Leaning tombstone |

Each shape carries a visible text label matching the status name. Colour is not the only differentiating signal (Requirement 6.2).

Tombstone height: `clamp(lifespanYears * 12, 40, 220)` pixels, where `lifespanYears` is the whole-year difference between the Epitaph's `first` and `last` ISO dates. A `dead` link with no Epitaph uses the minimum height of 40 px. Maximum height is capped at 220 px (reached at 30+ years of lifespan).

The moon icon advances one step per result received during a scan.

**Ledger table** — one row per link showing: URL, verdict label, reason, Resurrection URL (where available), and an exclude checkbox. Includes a "download patched document" button.

Patching runs entirely in the browser by calling the same `patch()` function from core (bundled with the page). The result is downloaded as a `Blob` URL.

**Accessibility**:
- Every interactive control is reachable and operable by keyboard alone.
- Each new result appended during a scan is announced via an ARIA live region with `aria-live="polite"`.
- When `prefers-reduced-motion` is active, all animations (rising, drifting, fading, pulsing) are suppressed entirely.
- If no Resurrection exists for a `dead` link, the Resurrect control is disabled and labelled to indicate no archived version is available.

**Sample document**: a single-activation control loads a pre-supplied document and triggers a scan without user input, so a reviewer can test the full flow without typing anything.

### CLI (`src/cli/`)

Entry point: `revenant <file|url> [--fix] [--json]`

- Reads a file path or a URL, runs `scan` with the default `fetcher`, collects all `Judgement` objects.
- Default output: one line per non-`alive` link to stdout — original URL, verdict, reason, Resurrection URL (or a placeholder when none exists).
- When all links are `alive`: prints nothing and exits 0.
- Exit code: 1 if any link is `dead` or `possessed`; 0 otherwise. `restless` does not fail the run.
- `--fix`: overwrites the input file in place with the output of `patch()`. If the input is a URL rather than a file path, prints an error and exits 2.
- `--json`: prints a single JSON structure containing every checked link (URL, verdict, reason, Resurrection, Epitaph, spans). Suppresses the per-line format.
- When both `--fix` and the input is a URL with `--json` also set, the error is emitted as a JSON structure.

### MCP Server (`src/mcp/`)

A stdio MCP server exposing two tools.

**`check_links(text | urls[])`**
- If the input contains no URLs, or the URL list is empty: returns an MCP error response — not an empty Judgement list.
- Otherwise: returns one `Judgement` per distinct URL, applying the same 200-URL cap and safe-fetching rules as the web application.

**`resurrect(url, date?)`**
- Returns the Wayback snapshot closest to `date`, or the most recent snapshot when no date is provided.
- If no snapshot exists and the Wayback Machine is unreachable: returns both "link is lost" and "archive availability unknown".
- If only no snapshot exists: returns "link is lost", no URL.
- If only the Wayback Machine is unreachable: returns "archive availability unknown".

Both tools call `guard()` on every URL and produce a `restless` verdict with the rejection reason for any URL that fails, identical to the verdict the web application would produce.

## Data Models

### Input resolution

| `kind` | Source | Effective parse kind |
|---|---|---|
| `'markdown'` | Provided string | `markdown` |
| `'html'` | Provided string | `html` |
| `'url'` | Fetched page body | `markdown` or `html` based on `Content-Type`; error if undetectable |
| `'repo'` | GitHub default-branch README | `markdown` |

### SSE event payloads

```ts
// event: meta
interface MetaEvent { total: number; capped: boolean; capLimit: 200 }

// event: judgement
type JudgementEvent = Judgement;

// event: done
// (no data payload)
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

### Wayback cache entry

```ts
interface WaybackCacheEntry {
  epitaph?: Epitaph | 'unavailable';
  resurrection?: string;
  snapshotText?: string;
  cachedAt: number;        // Date.now()
  ttlMs: 86_400_000;       // 24 hours
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Each property below corresponds to one property-based test in `test/*.prop.test.ts`, implemented with **fast-check** at a minimum of 100 iterations. Each test is tagged with a comment in the form:

```
// Feature: revenant, Property N: <property title>
```

### Property 1: Patch touches only link targets

*For any* source string and any list of judgements, removing all link-span byte ranges from both `source` and `patch(source, judgements, excluded)` yields identical strings. Bytes outside link target spans are never modified by `patch`.

**Validates: Requirements 4.2**

### Property 2: The living are left alone

*For any* source string where every judgement carries verdict `alive` or `restless`, `patch(source, judgements, new Set())` returns a string byte-for-byte equal to `source`.

**Validates: Requirements 4.3**

### Property 3: Patch is idempotent

*For any* source string, applying `patch` twice — where the second pass re-extracts links from the already-patched output and treats all Wayback URLs as `alive` — produces the same result as applying `patch` once. Fresh re-evaluation, not stored state, is what achieves idempotency.

**Validates: Requirements 4.4**

### Property 4: Extraction round-trips

*For any* Markdown source built from a known list of URLs in any of the four syntactic forms (inline, reference, autolink, bare), `extract(source, 'markdown')` returns exactly those URLs (excluding any wrapped in generated fenced code blocks), and `source.slice(span.start, span.end)` equals the URL string for every span in the result.

The same round-trip holds for HTML: for any HTML built from known `href` values, `extract(source, 'html')` returns exactly those URLs with correct spans.

**Validates: Requirements 1.1, 1.2, 1.5, 1.6**

### Property 5: Similarity is a proper measure

*For any* strings `a` and `b`: `similarity(a, b)` is in `[0, 1]`; `similarity(a, a) === 1` for any non-empty `a`; and `similarity(a, b) === similarity(b, a)`.

**Validates: Requirements 2.5**

### Property 6: Never cry wolf

*For any* `Probe` with `status` 401, 403, or 429, `classify` never returns verdict `dead`. *For any* `Probe` with `outcome === 'timeout'`, `classify` never returns verdict `dead`. *For any* `Probe`, `classify` returns exactly one verdict and a non-empty reason string. *For any* `Probe` whose `finalUrl` shares the same registrable domain as the requested URL, `classify` never returns verdict `possessed`.

**Validates: Requirements 2.3, 2.4, 2.8, 2.9**

### Property 7: The guard holds

*For any* URL whose host is an IPv4 or IPv6 literal in a blocked range, `localhost`, or ends in `.local`, `.internal`, or `.localhost`, or whose scheme is not `http` or `https`, or that contains a userinfo (credentials) component, `guard` returns `ok: false` with a non-empty reason string.

**Validates: Requirements 5.1**

### Property 8: Excluded links survive the patch unchanged

*For any* source string, any set of `dead` judgements that have resurrections, and any non-empty excluded set, the original URL bytes at every excluded link's spans appear unchanged in the output of `patch(source, judgements, excluded)`.

**Validates: Requirements 4.5**

### Property 9: Deduplication invariant

*For any* Markdown or HTML source containing the same URL at multiple distinct locations, `extract` returns exactly one `Link` for that URL, and the number of spans on that `Link` equals the number of occurrences of the URL in the source.

**Validates: Requirements 1.6**

### Property 10: Concurrency cap invariant

*For any* scan over more than 6 URLs (with a fake instrumented `Fetcher`), the number of in-flight concurrent `fetcher` calls never exceeds 6 at any point during the scan.

**Validates: Requirements 5.4**

### Property 11: Tombstone height formula

*For any* whole-year lifespan value `y ≥ 0`, the computed tombstone height `clamp(y * 12, 40, 220)` is in `[40, 220]`, equals 40 for `y === 0`, increases linearly until it reaches 220 at `y === 30`, and remains 220 for all `y > 30`.

**Validates: Requirements 6.3**

## Error Handling

| Failure | Behaviour |
|---|---|
| Input page or repo cannot be fetched (non-2xx, connection error, or undetectable content type) | 422 JSON `{ error }` from the Worker; CLI prints to stderr and exits 2; nothing is scanned |
| Wayback Machine unreachable or times out (10 s) | Verdict retained; Epitaph set to `'unavailable'`; UI displays "the archive is silent" |
| 429 from Wayback Machine | Wait `Retry-After` (capped at 10 s), retry once; on second failure, Epitaph `'unavailable'` |
| SSE connection drops mid-scan | UI keeps received results and offers "resume" (rescan of the missing URLs) |
| URL rejected by `guard` | Verdict `restless` with rejection reason; no outbound request made |
| Response body exceeds 512 KB | Body discarded; body-size error reported in `Probe` |
| Timeout and body-size error both occur | Both errors reported simultaneously |
| `--fix` given a URL instead of a file path | Error to stderr (as JSON when `--json` also set); exit code 2 |
| `check_links` called with no URLs | MCP error response; not an empty Judgement list |
| Redirect target fails `guard` | Request rejected; verdict `restless` with rejection reason |

Errors from the HTTP API always use the shape `{ error: string }`. Stack traces are never exposed.

## Testing Strategy

### Dual approach

Unit tests and property tests are complementary. Unit tests verify specific examples and edge cases; property tests verify universal invariants across a wide generated input space. Avoid writing unit tests that duplicate what a property test already covers at scale.

### Property-based tests (`test/*.prop.test.ts`)

Library: **fast-check** (TypeScript/Node.js). Minimum 100 iterations per property.

Each test is tagged:
```ts
// Feature: revenant, Property N: <property title>
fc.assert(fc.property(...), { numRuns: 100 });
```

Generators required:

| Generator | Produces |
|---|---|
| `arbMarkdownSource(urls)` | Markdown string containing the given URLs in random syntactic forms; some optionally inside fenced code blocks |
| `arbHtmlSource(urls)` | HTML string with `<a href="...">` elements for the given URLs |
| `arbProbe()` | `Probe` objects spanning all `outcome` and `status` combinations |
| `arbJudgements(links)` | `Judgement` arrays consistent with a given `Link[]` |
| `arbUrl()` | URLs covering edge cases: private IPs, localhost, blocked suffixes, non-http schemes, credentials, valid http/https |
| `arbLifespan()` | Non-negative integers representing whole years |

Each of the eleven correctness properties maps to one `fc.assert` call.

### Unit tests (`test/*.test.ts`)

- `classify()`: one test per row in the decision table, using recorded `Probe` fixtures.
- `guard()`: explicit tests for each IP range, hostname pattern, and scheme.
- `patch()`: concrete examples — single replacement, multiple replacements, excluded links, no dead links, right-to-left ordering correctness.
- `extract()`: inline links, reference links, autolinks, bare URLs, fenced block exclusion, duplicate URL deduplication, `mailto:` exclusion.
- `similarity()`: concrete text pairs including the calibration examples from `docs/brief/calibration.md` (expected results: paul graham ~1.0, kiko.com ~0.0, HN ~0.13).
- Wayback client: fixture responses for CDX, Availability API, snapshot text fetch, 429 back-off, unreachable.

### Integration tests (`test/*.int.test.ts`)

One integration test for `scan` uses a fake `Fetcher` (no real network) covering all four verdicts across a 10-link document. The fake fetcher simulates: DNS failure, 404, 5xx with retry, 403, timeout, 2xx same-domain redirect, 2xx cross-domain redirect with low-similarity snapshot. No real network calls in CI.

The CLI is tested with a temporary file and a fake `Fetcher` shim to verify exit codes and output formats for the default, `--fix`, and `--json` flag combinations.

The MCP server is tested with fake Fetcher and Wayback client, covering `check_links` (with text, with URL list, with empty input) and `resurrect` (snapshot found, not found, Wayback unreachable, both).

### Accessibility tests

A single Playwright test verifies: ARIA live-region announcements fire for each new result; every interactive control receives keyboard focus; the sample document control triggers a scan without text input; `prefers-reduced-motion` suppresses all animations.

### Manual verification

Before deployment, the sample document must produce at least one of each verdict (`alive`, `dead`, `possessed`, `restless`) on the live Worker.
