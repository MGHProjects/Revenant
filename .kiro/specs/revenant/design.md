# Design Document: Revenant

## Overview

Revenant is a link-rot checker and document patcher. It scans Markdown, HTML, or remote documents, assigns a trustworthy verdict to every absolute HTTP/HTTPS link it finds, retrieves archived copies of dead or hijacked links from the Wayback Machine, and produces a patched document with broken links replaced. It is exposed through three surfaces: a streaming web UI (the Graveyard), a CLI for CI pipelines, and an MCP server for AI agent use.

The central design principle is a **pure core with thin doors**: all logic lives in pure functions under `src/core/`; network I/O lives in `src/net/`; and the three doors (Worker, CLI, MCP) only feed the core and render its output. The `Fetcher` type is an injected dependency so the core has zero I/O coupling, making every core function fast and deterministic to test.

## Architecture

```
 web ──batch JSON──▶ worker ──────────────────┐
 cli ──┐                                         ├─▶ judgeLink(link, deps, options) ─▶ net ─▶ internet
 mcp ──┴─▶ scan(input, kind, fetcher, wayback, now) ─┘            │
                                                         └─▶ core (extract, guard, classify, similarity, visible-text, patch)
```

**Layers:**

| Layer | Location | Responsibility |
|---|---|---|
| Core | `src/core/` | Pure functions only: `extract`, `guard`, `similarity`, `classify`, `patch`, `visible-text` |
| Net | `src/net/` | Stateful I/O: `fetcher`, Wayback client, `archive-queue` (one line for all Internet Archive traffic), `judge-link` (the one per-link judgement), `scan` async generator |
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
  dnsFailure?: true;                    // set only when DoH confirmed NXDOMAIN
}

interface Epitaph { first: string; last: string; copy: string }   // ISO dates; copy = the capture the resurrection opens

interface Judgement {
  link: Link;
  verdict: Verdict;
  reason: string;
  epitaph?: EpitaphResult;
  resurrection?: string;               // snapshot URL
}

type Fetcher = (
  url: string,
  init?: { timeoutMs: number; maxBytes: number }
) => Promise<Probe>;

// Wayback client interface — injected so tests can fake it
// EpitaphResult = Epitaph | 'none' | 'unavailable'
//   'none'        archive answered, no 200 capture (never archived)
//   'unavailable' archive could not be reached (connection error, HTTP error, bad reply, timeout, second 429)
// archiveNote(judgement) in src/core/archive-note.ts is the one place the user-facing sentences live:
//   'none' -> 'Lost: never archived'; 'unavailable' -> 'The archive could not be reached. Try again.'
type SnapshotResult =
  | { status: 'text'; text: string }
  | { status: 'none' }
  | { status: 'unavailable' };
interface Wayback {
  // One CDX answer yields the epitaph and the resurrection together, or neither.
  getArchive(url: string): Promise<ArchiveAnswer>;   // ArchiveAnswer = { epitaph: EpitaphResult; resurrection?: string }
  // 'text' = the copy capture's visible text; 'none' = archive answered, no usable 200 capture;
  // 'unavailable' = archive could not be reached for the CDX lookup or the id_ body (never cached).
  // Pass the ArchiveAnswer already fetched for this judgement so the CDX is not requested twice.
  getSnapshotText(url: string, archive?: ArchiveAnswer): Promise<SnapshotResult>;
  // Closest snapshot to `date` (YYYY-MM-DD), or the most recent when omitted. Optional so older fakes still type-check.
  getClosestSnapshot?(url: string, date?: string): Promise<ClosestSnapshot>;
}
// ClosestSnapshot = { status: 'found'; url: string; date: string } | { status: 'none' } | { status: 'unreachable' }

// Scan event union — all events yielded by scan()
type ScanEvent =
  | { type: 'meta'; total: number; capped: boolean; capLimit: 200 }
  | { type: 'judgement'; judgement: Judgement }
  | { type: 'error'; message: string };
// Contract: a later `judgement` event for the same URL (judgement.link.url) replaces the earlier one.
// scan() emits one judgement per link, then, after the pool finishes, one more for each link whose
// judgement had `archiveUnavailable`. The final judgement per URL is the last one received.
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

Parentheses (CommonMark balanced parentheses):
- Inline destination (`parseDestination`): leading whitespace is skipped. `<...>` takes everything up to `>` (spaces and parentheses allowed, no newline). Otherwise a depth counter runs: `(` adds one, `)` subtracts one, and the destination ends at whitespace, at `>`, or at the first `)` that would take the depth below zero. `\(` and `\)` are not counted. The destination must be followed by `)` or whitespace (an optional `"title"`, `'title'` or `(title)` follows). The span is exactly the destination.
- Reference definitions `[id]: url` and `[id]: <url>`: the destination is the `\S+` run or the `<...>` content; the span excludes the angle brackets. Autolinks `<url>` take everything up to `>`, so parentheses are kept.
- Bare URLs: the token runs to whitespace or one of `<>]"'` `,;`. Then trailing `.,;:!?` are stripped, and a trailing `)` is stripped only while the URL has more `)` than `(` (GFM). A bare URL directly after `(` or `<` is left to the inline or autolink scanner.
- A URL with no host (`http://`, `https:///x`) is not extracted in any form, including HTML.
- A span recorded twice for the same position (a reference definition reached as a reference and as a bare URL) is kept once.

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

#### `classify(probe: Probe, originalUrl: string, snapshot?: SnapshotResult) → { verdict: Verdict; reason: string }`

Decision table, evaluated top to bottom; first match wins:

| Condition | Verdict | Reason format |
|---|---|---|
| `outcome === 'timeout'` | `restless` | `No answer within 8 s. Not judged.` |
| `outcome === 'network-error'` AND `dnsFailure` (NXDOMAIN confirmed) | `dead` | `The domain no longer resolves.` |
| `outcome === 'network-error'` (any other) | `restless` | `Connection failed ({text}). Not judged.` (no text: `Connection failed. Not judged.`) |
| `status` is 401 | `restless` | `Answers 401: needs a login. Not judged.` |
| `status` is 403 or 429 | `restless` | `Answers {status} to robots. Not judged.` |
| `status` is 404 or 410 | `dead` | `Answers {status}.` |
| `status` is 5xx (after retry) | `restless` | `Answers {status}, twice. Not judged.` |
| `status` is 2xx AND `redirectKind(url, finalUrl)` is `moved` (known rename in `known-renames.ts`, or same name label under another public suffix). Checked first for a cross-domain 2xx, needs no snapshot; `judgeLink` makes no Wayback call for it | `alive` | `Moved to {domain}.` |
| `status` is 2xx AND `finalUrl` has a **different** registrable domain AND `snapshot` is `text` AND the live visible text is shorter than `MIN_LIVE_TEXT_CHARS` (200) | `restless` | `Redirects to {domain}; the new page has too little text to compare. Not judged.` |
| `status` is 2xx AND `finalUrl` has a **different** registrable domain AND `snapshot` is `text` AND `similarity(probe.text, snapshot.text) < 0.2` | `possessed` | `Redirects to {domain}; {n}% like the archived page.` |
| `status` is 2xx AND `finalUrl` has a **different** registrable domain AND `snapshot` is `unavailable` (archive could not be reached) | `restless` | `Redirects to {domain}; the archive could not be reached to compare. Not judged.` |
| `status` is 2xx AND `finalUrl` has a **different** registrable domain AND `snapshot` is `none` or absent | `alive` | `Redirects to {domain}; no archived copy to compare.` |
| `status` is 2xx (same domain, or cross-domain with similarity ≥ 0.2) | `alive` | `Answers {status} with the page you cited.` |
| any other status | `restless` | `Answers {status}. Not judged.` |

Guard rejections (built in `scan` and the Worker `/api/scan`, so MCP inherits them): `restless`, `Not checked: {reason}.`

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
- **DNS confirmation**: one shared helper, `confirmNoDns(host)` in `src/net/dns.ts`, used when `fetch` throws (not on abort) and when any hop answers HTTP 530 (Cloudflare error 1016, which is how Workers report a host that does not resolve). It queries `https://cloudflare-dns.com/dns-query?name={host}&type=A` (`accept: application/dns-json`, 3 s timeout). `Status: 3` confirms. `Status: 0` with no A answer triggers one `type=AAAA` query; `Status: 0` with no AAAA answer confirms (CNAME-only answers count as no record). Anything else (records present, other status, DoH error, timeout, non-2xx) is "not confirmed". It never throws. A confirmed failure yields `Probe { outcome: 'network-error', dnsFailure: true }` (`dead`, "The domain no longer resolves.") and is never retried. An unconfirmed 530 is returned as a normal 5xx response that carries `noRetry` (any DoH query spent, to keep the subrequest budget) and classifies as `Answers 530. Not judged.`. No DoH query for guard rejections or redirect errors.
- **Subrequest budget** (free plan: 50 per invocation; every fetch counts, and so do Cache API `match`/`put` calls): worst case per URL is **16** (`PER_URL_WORST_CASE` in `src/net/judge-link.ts`), so 3 URLs = 48. A 5xx twice (6 hops + 6 hops on the retry, which passes `skipDns` and makes no DoH query) followed by a cross-domain 2xx costs 12 + CDX 2 + `id_` 2 = 16, where each Wayback call is 1 plus 1 retry after a 429. A thrown fetch on the 6th hop with a confirmed DNS failure is 6 + 2 DoH + CDX 2 = 10. A 530 on the 6th hop with DoH queries is not retried and skips Wayback (8). Redirect hops and 530/429/non-2xx Wayback bodies are cancelled unread, which also frees the 6 connection slots. The Worker makes no Cache API calls. `test/worker-budget.test.ts` forces each path and counts fetch plus cache calls.
- **Archive hosts**: `createFetcher({ archiveQueue })` builds a fetcher whose hops to `archive.org`, `web.archive.org` or any `*.archive.org` host run inside the archive queue (next section). The check is per hop, on the host of the URL about to be requested: the initial URL and every redirect target, so a redirect that lands on the archive on any hop waits for the queue too, and a hop that leaves it does not. Each hop is still guarded before it is followed and the limit stays 5 redirects (6 requests). A 429 or 503 from such a hop that carries `Retry-After` calls `queue.penalize`, so the next archive request waits for everyone. The plain `fetcher` export has no queue (used by tests and by `/api/resolve`).
- **Timeout**: 8-second deadline; returns `Probe { outcome: 'timeout' }` on expiry. Time spent waiting in the archive queue does not count: the deadline is a budget that is paused while a hop waits, and the hop's own limit starts when it starts.
- **Body size**: reads at most 512 KB. If the body exceeds that limit, reading stops and the truncated body is used as the full response (the request is **not** treated as an error).
- **5xx retry**: the `scan` orchestrator (not the fetcher) retries once after 2 seconds when the first response is 5xx.

#### Wayback Machine client (`src/net/wayback.ts`) — implements `Wayback`

The `Wayback` interface is injected into `scan`, enabling the integration test to fake it without real network calls.

The Wayback APIs used (one CDX request per URL):

| Purpose | Endpoint |
|---|---|
| Epitaph and Resurrection | `https://web.archive.org/cdx/search/cdx?url={u}&output=json&fl=timestamp,length&filter=statuscode:200&collapse=timestamp:6` (one 200 capture per month, oldest first, with body length) |
| Resurrection URL | Built from the chosen capture: `https://web.archive.org/web/{timestamp}/{url}` (no further API call) |
| Snapshot text for `possessed` check | `https://web.archive.org/web/{timestamp}id_/{url}` |

The client parses the header row and reads `timestamp` and `length` by column; a `length` of `-` or any non-numeric value is unknown. `chooseLife` in `src/core/lives.ts` (pure) picks the capture range: captures are split into lives wherever more than 12 calendar months (from the yyyymm part) separate consecutive captures; the longest life by span wins (tie: earliest); Epitaph first and Epitaph last are the life's first and last captures (the stone shows the whole life). The copy, which the Resurrection and the possessed comparison use, is stepped back from the end because pages decay before they die: `span` = calendar months from the life's first to its last capture, `margin = min(12, floor(span / 4))`, `cutoff` = the month of the last capture minus `margin`, `candidates` = the life's captures at or before the cutoff month; the copy is the last candidate whose length is at least half the median candidate length, else the last candidate (a one-capture life is its own copy). This keeps a later domain takeover (a parked or gambling page) and the soft-404 pages that sites serve while dying out of the resurrection. `getSnapshotText` fetches the `id_` body of the copy capture, and MCP `resurrect` without a date uses it too (`snapshotDate` = the copy date); with a date, MCP keeps the closest-snapshot lookup (Availability API). No separate Availability call is needed for scans.

**Caching**: all Wayback responses are cached for 24 hours. Every environment uses an in-memory `Map` keyed by URL (in the Worker it lives as long as the isolate). The platform Cache API is not used: its `match`/`put` calls count toward the Worker's 50 subrequests and would push the per-URL worst case past 16. Wayback bodies are read through the shared `readCapped` (`src/net/read-capped.ts`), 512 KB, stream cancelled at the cap, truncated body used as complete. Cache entry shape:

```ts
interface WaybackCacheEntry {
  epitaph?: EpitaphResult;
  resurrection?: string;
  snapshot?: SnapshotResult; // never `unavailable`
  cachedAt: number;
  ttlMs: 86_400_000;
}
```

**429 back-off**: a 429 sets a pause of the `Retry-After` value (seconds or HTTP-date, capped at 10 s; 1 s when the header is absent) on the archive queue, then the request is retried once as a new queue entry, so it starts after the pause; on second failure set Epitaph to `'unavailable'`. A 503 with `Retry-After` sets the same pause but is not retried. An empty CDX result (`[]` or header row only) sets Epitaph to `'none'`. `'unavailable'` is never cached; `'none'` is cached 24 h. The same holds for `getSnapshotText`: `{ status: 'unavailable' }` (CDX lookup or `id_` body failed) is returned but never stored, in memory, so a later call asks the archive again; `{ status: 'text' }` and `{ status: 'none' }` are cached 24 h.

**Unreachable / timeout**: on connection error, HTTP error response, or no response within 10 s (counted from the moment the request starts, not from when it was queued), retain existing verdict and set Epitaph to `'unavailable'`.

#### Archive queue (`src/net/archive-queue.ts`)

The Internet Archive throttles clients that send several CDX and `id_` requests at once. A field test on 26 Nov 2026 (200 links, six in flight) got "the archive could not be reached" for 13 of 14 cross-domain links and no archived copy for 7 of 8 dead links in one README and 4 of 4 in another. All traffic to the archive now goes through one `ArchiveQueue`:

- **One at a time, with a gap.** `run(task, { timeoutMs })` starts a task when the previous one has finished and at least `minGapMs` after the previous start.
- **Penalty.** `penalize(ms)` sets "no request starts before now + ms" (the longest pending penalty wins). It affects every waiter, not just the caller. `parseRetryAfter` reads seconds or an HTTP-date and caps the value at 10 s.
- **Timeout.** Each task gets an `AbortSignal` that fires `timeoutMs` (10 s) after the task starts. Waiting in the queue does not count. A task that ignores the signal is released with `ArchiveTimeoutError` once the time is up, so the queue cannot stall.
- **A throwing task** rejects its caller only; the next task runs.
- **No shared state.** `createArchiveQueue({ minGapMs, clock? })` returns an instance with its own line. The clock (`now`, `setTimeout`, `clearTimeout`) is injectable, so tests use a fake clock and wait for nothing. The only module-level value is `defaultArchiveQueue()`, a lazy instance for the CLI and MCP doors, reset with `resetDefaultArchiveQueue()`.
- **The gap constant** is `ARCHIVE_MIN_GAP_MS = { node: 1000, worker: 300 }`, exported from `archive-queue.ts`. The CLI (`src/cli/run.ts`) and MCP (`startStdio`) use the default queue, which takes `node`. The Worker builds one queue per `/api/scan` request with `ARCHIVE_MIN_GAP_MS.worker` and passes it to both `createFetcher` and `createWaybackClient`, so nothing is shared between requests.
- **What goes through it**: the CDX request, the `id_` body and the availability API (`getClosestSnapshot`) in `wayback.ts`, and every fetcher hop to an archive host. `createWaybackClient()` without a queue makes a private one with no gap, so existing fakes and tests behave as before.

The queue changes timing, not call counts: the Worker budget (`PER_URL_WORST_CASE` = 16, 3 x 16 = 48) is unchanged and `test/worker-budget.test.ts` still counts it.

**Added latency for a 3-URL Worker batch** (from the code, not measured): a possessed link makes at most 2 archive requests (CDX, then `id_`), so three possessed links make 6, and the queue runs them one after another with 300 ms between starts: at least 5 x 300 = 1.5 s of waiting, plus the requests no longer overlap, so the batch takes the sum of their durations instead of the longest. With a 429 on every CDX and `id_` (the budget's worst case, 12 requests) the gaps add 11 x 300 = 3.3 s and each Retry-After adds up to 10 s. A request that hangs holds the line for at most 10 s. `/api/scan` sends nothing until the batch is done and has no hard limit of its own. The browser's `fetch` has no timeout in `web/`, so a slow batch only keeps its tombs under the mist longer. The browser sends 2 batches at a time and each Worker request has its own queue, so up to two archive requests can be in flight from the Worker, one per batch.

#### `scan(input: string, kind: InputKind, fetcher: Fetcher, wayback: Wayback, now: Date)` — async generator

```ts
type InputKind = 'markdown' | 'html' | 'url' | 'repo';
```

Yields `ScanEvent` objects. Used by CLI and MCP only. The Worker calls `judgeLink` directly for each URL of a batch; `scan` does the same for each link in its pool, so every door gives the same verdict for the same link.

The six steps:

1. **Resolve input**: if `kind` is `'url'`, fetch the page and detect `Content-Type` for effective parse kind. If `kind` is `'repo'`, fetch the default-branch README from the GitHub API as Markdown. On failure or undetectable content type: yield `{ type: 'error', message }` and halt.
2. **Extract**: call `extract(source, effectiveKind)` → `Link[]`.
3. **Cap**: if more than 200 distinct URLs, keep the first 200 and emit `{ type: 'meta', total: actualCount, capped: true, capLimit: 200 }`. Otherwise emit `{ type: 'meta', total: actualCount, capped: false, capLimit: 200 }`.
4. **Pool of 6**: run `judgeLink` for every link with a concurrency pool of exactly 6. A link rejected by `guard(link.url)` yields `restless` without any request. For each remaining URL `judgeLink` does:
   - `fetcher(url, { timeoutMs: 8000, maxBytes: 524288 })` → `Probe`.
   - If 5xx: wait 2 s and call `fetcher` once more.
   - Only if 2xx AND `finalUrl` has a different registrable domain from `url`: call `wayback.getSnapshotText(url)`.
   - `classify(probe, url, snapshot?)` → `{ verdict, reason }`.
   - If `dead` or `possessed`: call `wayback.getArchive(url)` → Epitaph and Resurrection from the chosen capture (reusing the answer already fetched for the snapshot text).
   - Yield `{ type: 'judgement', judgement }`.
5. **Same-domain alive links** cost zero Wayback calls.
6. **Final retry.** When the pool has finished, `scan` collects the judgements with `archiveUnavailable` (set by `judgeLink`) and calls `judgeLink` once more for exactly those links, with the same `deps`, through the same pool of 6 (archive work is serialised by the archive queue inside the fetcher and the Wayback client). Each answer is emitted as another `{ type: 'judgement' }` event and supersedes the earlier judgement of the same URL (see the `ScanEvent` contract). It runs once: a judgement that is still flagged afterwards is final. Restless links whose cause is the site (403, 429, timeout, 5xx) carry no flag and are never retried.

**Consumers of the event stream.** A door keeps the last judgement per URL (a `Map` keyed by `link.url`, in the order URLs first appeared). The CLI `--json`, `--fix`, summary line and exit code, and the MCP `check_links` result, use that final judgement, so each URL appears once. The CLI streaming output (no `--json`, no `--fix`) prints each link's first line as soon as it arrives, as before. For a superseded link it prints the new line, marked ` [asked again]`, only when it differs from the line already shown (verdict, reason or archive copy changed); a link that turns `alive` prints a line too, so the earlier restless line is not left standing; an unchanged answer prints nothing.

#### `judgeLink(link, { fetcher, wayback, sleep }, { textCap? })` (`src/net/judge-link.ts`)

The single per-link judgement, and the only place the Worker's subrequest budget refers to. It runs: `guard` → fetch (8 s, 512 KB) → one retry after 2 s with `skipDns` on 5xx (`shouldRetry`) → cross-domain snapshot lookup → `visibleText` of the live body → `classify` → epitaph and resurrection for dead/possessed. Live body and snapshot get the same transformation: visible text, then the optional `textCap` on each side. The Worker passes `textCap: 65536`; CLI and MCP leave it unset. Fetcher, Wayback client and `sleep` are injected, so tests need no real timers.

### Worker (`src/worker/`)

A Hono application running on the Cloudflare free plan (50 subrequests, 10 ms CPU per request). No SSE — responses are plain JSON.

**`POST /api/scan`**

- Request body: `{ urls: string[] }` — at most 3 URLs. Body size limit enforced in code (not relying on runtime defaults).
- Response: `{ judgements: Judgement[] }` as plain JSON.
- Errors: `{ error: string }` with appropriate 4xx status. Stack traces never exposed.
- Internally: runs `judgeLink` (guard included) for each URL concurrently with `textCap: 65536`, staying under 50 subrequests. The request builds one archive queue (`ARCHIVE_MIN_GAP_MS.worker`, 300 ms) shared by its fetcher and its Wayback client, so the archive requests of the three links run one at a time. For the `possessed` check, `similarity` is applied to the first 64 KB of visible text.

**`POST /api/resolve`**

- Request body: `{ input: string, kind: 'url' | 'repo' }`.
- Response: `{ source: string, kind: 'markdown' | 'html', file?: string }` — the fetched and content-typed source text. `file` is present for `kind: 'repo'` only: the README's name when a raw name answered (`README.md`, `readme.md`, `README`, `Readme.md`, `README.markdown`), or the API's `path` (`docs/README.md`) falling back to its `name`. `resolveRepoReadme` returns it as `file`. The web page turns it into the ledger's GitHub link with `githubFileUrl` (`web/github-file.ts`, pure: validated owner/repo, relative path without `..`, each segment encoded; `blob/HEAD` until the edit form is checked in a logged-in browser).
- Errors: `{ error: string }`. 400 for invalid JSON or input. 500 `{ error: "Internal error" }` for unexpected exceptions (never a stack trace; same on `/api/scan`). For `kind: 'url'` the shared `fetcher` is used (guard on every redirect hop, max 5; 8 s timeout covering the body read; 512 KB cap, truncation is not an error). Kind comes from the Content-Type header (`Probe.contentType`) or a body sniff. 422 when the address cannot be loaded: non-2xx (`it answered {status}`), timeout (`no answer within 8 s`), guard rejection (`That address is not allowed: {reason}`, `Probe.blocked`), confirmed DNS failure (`the domain no longer resolves`), or other network error. For `kind: 'repo'`: 404 not found (or no README), 429 GitHub rate limit, 400 invalid `owner/repo`, 502 GitHub unreachable.
- Repo input uses `resolveRepoReadme(slug, fetchImpl?, githubToken?)` in `src/net/github-readme.ts`, shared with `scan.ts`. Flow: (1) sequentially request `https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{name}` for `README.md`, `readme.md`, `README`, `Readme.md`, `README.markdown`, stopping at the first 200 (decoded as UTF-8 through the capped reader, kind `markdown` for every name; bodies of non-200 answers are cancelled; any non-200 or network error moves to the next name). (2) Only if none answered 200, `GET https://api.github.com/repos/{owner}/{repo}/readme` (any file name, `docs/`), decoding `content` as base64 bytes then UTF-8 and falling back to `download_url` (`raw.githubusercontent.com` only) when content is empty. API 404 is `not-found`, 403 with `x-ratelimit-remaining: 0` or 429 is `rate-limited`, other statuses and network errors are `unavailable`. `githubToken` is sent as `Authorization: Bearer` to the API only, never to raw, and never logged. It is a parameter because `src/net` does not read `process.env`: the CLI passes `process.env.GITHUB_TOKEN`, and the Worker passes its optional `GITHUB_TOKEN` secret. Budget: `/api/resolve` has its own 50 subrequests; worst case is 5 raw + 1 API = 6, and a hit on `README.md` costs 1. 8 s timeout, 512 KB body cap.
- Used by the browser before it starts batching, so the browser can run `extract` locally.

Static assets are served from `dist/` (the Vite build output). `wrangler.toml` uses `[assets]` (not the legacy `[site]` bucket).

### Ask again (`web/ask-again.ts`, `web/graveyard.ts`)
`Judgement.archiveUnavailable?: true` is set in one place in `judgeLink` (after classify), from structured values: a restless verdict with snapshot `'unavailable'`, or a dead/possessed judgement whose epitaph is `'unavailable'`. The pure module `ask-again.ts` has `canAskAgain` (restless, or flagged), `retryIndexes` (flagged links, for the automatic retry), `chunk` and `mergeJudgement`. `graveyard.ts` runs `askAgain(index)` (one URL to `/api/scan`) and, at scan end, `retryArchive(gen)` once: batches of 3, 2 in flight, no reveal wait, results discarded when `scanGen` changed. Both use `applyReplacement`, which swaps the plot `li`, the ledger row and the inscription, then re-renders tally and patch note. The CLI `--json` and MCP output carry the flag when the archive was still unavailable after `scan`'s own final retry (step 6 of `scan`).

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

**Load assembly (Requirement 6.20)** — the horizon assembles once per page load with plain CSS animations on the static elements (hill fade, left fence, tree, then gate and right fence rise 28 px, moon wrapper fades in). The "from" state lives only in the keyframes (`fill-mode: backwards`), so the existing reduced-motion rule leaves everything at its final state. `.moonbox` is animated, not `.moon` or `.sky`, because JS sets `--shade` and `--progress` there. The mist is held at 0 by `.ground.assembling` (in the HTML, only under `no-preference`) until `graveyard.ts` removes it after two animation frames; its existing 1.4 s opacity transition then runs. Nothing replays, since no class toggles on the animated elements.

**Full moon (Requirement 6.21)** — `moonlight()` in `web/graveyard.ts` runs right after `bell()` at the end of `runScan`, after `retryArchive`, and only there (not in `applyReplacement`, so Ask again never triggers it). It writes `--i` (index among `yard.children`) on every `<li>` and adds `.moonlit` to `.rv`; it does nothing under `prefers-reduced-motion`. `.rv.moonlit .yard .stone::after` is a full-size, clipped (`.stone` has `position: relative; overflow: hidden`) pseudo-element with the 115deg gradient, animated by `moon-sheen` (`translateX(-100%)` to `100%`, 700 ms ease-in-out, `calc(var(--i) * 70ms)`, fill both so it ends off the stone). `.rv.moonlit .glow` runs `moon-swell` (scale 1.12 at 50 %, 1.4 s). Neither start state exists outside the keyframes. `.moonlit` is removed when the last `moon-*` animation finishes (`animationend`/`animationcancel` listener on `.rv`) and in `resetScene`, so a later render cannot replay it.

**Candle (Requirement 6.22)** — `raisePlot` in `web/scene.ts` appends the static candle SVG to the plot's `.figure` (only for `dead` and `possessed`): at once when no ghost is shown, otherwise from the timeout that removes the ghost after 1300 ms (skipped if the plot is no longer connected or the ghost was replaced); `createPlot` adds it again for a view whose `raised` is true, so a re-rendered plot keeps it. `applyReplacement` carries `raised` over to the new view while the fresh answer is dead or possessed with a snapshot. `resetScene` empties the yard, which removes every candle. `.candle` is `position: absolute; bottom: 0; left: min(calc(50% + 40px), calc(100% - 16px)); overflow: visible; pointer-events: none`; `bottom: 0` is relative to the figure's padding box, so the base sits on the top edge of the 1 px border. A freshly raised candle has `.lighting`: `light 1.7s ease-out both` (no delay: the candle is not in the DOM until the ghost has left). `.flame` has the `drop-shadow(0 0 8px rgba(242,165,65,.6))` and `breathe` (opacity .85 to 1, 3 s, infinite alternate). The reduced-motion rule removes all animation, so the candle is simply there.

**What rises (Requirement 6.23)** — `buildFigure(verdict, { height, first, last })` in `web/scene.ts` returns `.figure > .riser > shape` and is the only place the chapel, stone, hand and fog are built: `createPlot` calls it with its `GraveView`, and `web/graveyard.ts` calls it at startup for each `[data-figure]` slot in `<section id="explain">` (the last section of `main .stack`, after `#ledger`), adding `aria-hidden="true"` to the figure. The text, the verdict spans (`li.alive .verdict` etc. reuse the plot colour rules) and the three README links are static HTML. CSS scoped to `.explain-grid` sets `.figure` to 130 px and `.rv .explain .riser, .lamp, .hand, .fog span { animation: none }`; plot rules are unchanged. The stone uses 2005 to 2014, `lifespanHeight` = 72 px (inside the 130 px box). Columns: 1, 2 from 480 px, 4 from 900 px. The only DOM difference from a plot's figure is that `aria-hidden` and the sample stone text.

Tombstone height: `clamp(lifespanYears * 8, 64, 176)` pixels (whole-year difference between Epitaph `first` and `last`). A `dead` link with no dates (Epitaph `'none'`, `'unavailable'` or missing) uses the minimum height 64 px. Maximum height is 176 px (reached at 22+ years). The possessed hand has a fixed height.

The moon icon advances one step per batch received. Batching: the browser extracts links itself (core bundled by Vite), sends at most 3 URLs per `POST /api/scan`, and keeps at most 2 requests in flight. For page-URL or repo inputs, the browser first calls `POST /api/resolve` to get the source text.

**Ledger table** — one row per link: URL, verdict label, reason, Resurrection URL (linked), exclude checkbox. Includes a "download patched document" button that calls `patch()` (bundled from core) and downloads via Blob URL.

**Accessibility** (cannot be cut):
- Every interactive control reachable by keyboard alone; logical tab order; visible focus indicator.
- Results container wrapped in one `aria-live="polite"` region; announcements are batched, not one per link.
- `prefers-reduced-motion`: no animations (rising, drifting, fading, pulsing) via `@media (prefers-reduced-motion: reduce)`.
- Colour contrast ≥ 4.5:1 (bone on ink).
- Sound off by default with a visible toggle.

**Sample document**: a single-activation control loads a pre-supplied document and triggers a scan without user input.

**Graveyard address** (`web/scan-address.ts`, wired in `web/graveyard.ts`): the pure module has `parseScanParams(search)` (precedence sample > repo > url; the first one present wins, and an invalid value is reported, never skipped) and `searchAfterScan(search, origin)`, where origin is `sample`, `address` or `text`. `url` is validated with the core `guard`, which has no network code and is bundled in the browser, so the browser and the Worker apply the same host rules. After `resolve` succeeds, `graveyard.ts` calls `history.replaceState` with the new query, so the back button is unaffected. Textarea scans clear `sample`, `repo` and `url`; the document is never an input of `searchAfterScan`. The "Copy link" `.btn.sm` sits under the sub-heading and is shown only when `shareable` is true.

**Hero input and result headline** (`web/index.html`, `web/graveyard.ts`, `web/result-headline.ts`): the hero holds, in DOM order, the status `<h1>`, the explanation (`#intro`), Copy link, the tally, the address form (`#hero-form`: label, `#address`, "Scan its links" `.btn.go`, `#address-error`) and the "Try:" row (`#try`: three plain anchors to `/?repo=...` and "Scan the sample" `.btn`). The address field has one id, `address`, and lives only in the hero; the lower form holds the textarea ("Or paste a document") and a secondary "Scan the document". `scan(mode)` takes `address`, `sample` or `text`: the hero form scans `address`, the lower form clears the address and scans `text`. Errors go to the paragraph of the field the scan came from (`errorField`); `showError` sets `aria-invalid` and `aria-describedby` on that field and `clearError` removes them. `syncChrome` shows the parts per state: **idle or failed without results** form, explanation, Try row; **scanning** the form stays in the layout with `#address`, "Scan its links" and "Scan the sample" `disabled` (dimmed by `.btn:disabled` and `.field:disabled`: opacity .45, `cursor: not-allowed`), never hidden, so the yard does not move when the scan ends; the explanation and the Try row hide at scan start, before the first plot, and `scan()` moves focus to the `<h1>` with `preventScroll` if it was inside the form or the Try row (a disabled control would drop it to the body); **results** the form only, enabled again, below the tally, so the user can scan another address and the page never strands them (focus is not moved at scan end). Known residual shifts, not caused by the form: the tally appears with the first batch, and the heading's text grows from the progress line to the result sentence at scan end. `resultHeadline({ total, dead, possessed, fixable, restless, failed })` is pure; `renderHeadline` builds its input from the plots on screen and runs at scan end and on every `renderTally` once `finished` is set, so Ask again and the automatic retry update it. The live region announces the final text once at the end.

**Focus must not scroll** (`web/graveyard.ts`, `web/styles.css`, task 20.1): `html` has `scroll-padding-bottom: var(--ins-h)` so that `revealSelected()`'s `scrollIntoView({ block: 'nearest' })` and keyboard focus on a plot keep the plot clear of the sticky inscription band. The same padding makes a plain `focus()` on an element inside the band (`#ins-action` link after Resurrect, `#ask-again` restored after Ask again) scroll the page to centre that element, so every such call is `focus({ preventScroll: true })`. Calls that target plots stay plain, because scrolling a plot clear of the band is wanted. `resurrect()` calls `select()`, whose `revealSelected()` does not move the page after Resurrect: the selected plot was already revealed when it was chosen, and `nearest` does nothing for a plot that is in view. `test/focus-scroll.test.ts` scans `web/*.ts` and fails on a band focus without `preventScroll: true` or an unclassified new `.focus(` call. `scripts/check-resurrect-scroll.mjs <port>` drives headless Edge at 1440x1080, 1366x768 and 1024x768 and asserts `scrollY` is unchanged after Resurrect (click and Enter) and Ask again, and that the ghost is inside the viewport 300 ms after Resurrect.

### CLI (`src/cli/`)

Entry point: `revenant <file|url> [--fix] [--json]`

Reads a file or URL, runs `scan` with a fetcher and a Wayback client that share the default archive queue (1 s gap; no free-plan limits on Node), and keeps the final `Judgement` per URL from the `ScanEvent` stream.

- Default: one line per non-`alive` link as it arrives — URL, verdict, reason, Resurrection (or placeholder). A superseding judgement (final retry) prints a second line ending ` [asked again]` only when it differs from the first; see "Consumers of the event stream". No output if all alive. Exit 1 if any final judgement is `dead` or `possessed`; exit 0 otherwise.
- `--fix`: overwrite file in place with `patch()` output for the final `dead` and `possessed` judgements. Error if input is a URL.
- `--json`: print `CliOutput` JSON with one entry per URL (the final judgement); suppress per-line format. Error output is JSON when `--json` is set.

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
| `'repo'` | GitHub default-branch README via `resolveRepoReadme` | `markdown` (`html` if the README file is `.html`/`.htm`) |

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
    epitaph?: EpitaphResult;
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

For any `Probe` with status 401, 403, or 429, `classify` never returns `dead`. For any `Probe` with `outcome === 'timeout'`, `classify` never returns `dead`. For any `Probe` with `status` 5xx (the after-retry path), `classify` returns `restless`, not `dead`. For any `Probe` with `outcome === 'network-error'` and no `dnsFailure`, `classify` never returns `dead` (6f). For any `Probe`, `classify` returns exactly one verdict and a non-empty reason. For any `Probe` whose `finalUrl` shares the same registrable domain as the requested URL, `classify` never returns `possessed`. Sub-properties 6h to 6j: a redirect to the same name label under another public suffix is never `possessed` (6h); a known rename, also from a subdomain, is never `possessed` (6i); a live text shorter than `MIN_LIVE_TEXT_CHARS` is never `possessed` (6j).

**Validates: Requirements 2.2, 2.3, 2.4, 2.8, 2.9, 2.11, 2.12, 2.13**

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

For any whole-year lifespan value `y ≥ 0`, `clamp(y * 8, 64, 176)` is in `[64, 176]`, equals 64 for all `y ≤ 8`, increases linearly (`y * 8`) between `y === 8` and `y === 22`, and equals 176 for all `y ≥ 22`.

**Validates: Requirements 6.3**

### Property 12: The chosen life is the longest continuous one

For any non-empty list of captures, `chooseLife` returns a `first`, `last` and `copy` that all come from the input, with `first ≤ copy ≤ last`, inside one life (no gap over 12 calendar months). That life's span is at least that of every other life, and strictly greater than any earlier life's (ties go to the earliest). `first` and `last` are the life's first and last captures. With `margin = min(12, floor(span / 4))`, so `margin ≤ 12` and `margin ≤ span / 4`, the copy's month is at most the last capture's month minus `margin`, and the copy is the last candidate (captures at or before that month) with length at least half the candidates' median known length, or the last candidate when none qualifies. A one-capture life returns that capture for all three. Input order does not matter.

**Validates: Requirements 3.1, 3.2**

### Property 13: Yard columns are balanced

For any plot count `n ≥ 1` and any `maxCols ≥ 1`, `cols = balancedColumns(n, maxCols)` satisfies `1 ≤ cols ≤ maxCols` and `cols × ceil(n / cols) ≥ n`. The layout uses the fewest rows possible (`ceil(n / maxCols)`), and the last row is short of `cols` by fewer plots than there are rows, so no plot sits alone under a wide empty row. With at most two rows, the rows differ by at most 1 plot (9 with room for 8 gives 5 + 4). With three or more rows a grid cannot always differ by 1 (13 with room for 6 gives 5 + 5 + 3), so the property states the weaker bound there.
**Validates: Requirements 6.1, 6.2**

### Property 14: Ask again replaces one judgement and nothing else
For any list of judgements, any position `i` and any fresh judgement, `mergeJudgement` (`web/ask-again.ts`) returns a list of the same length and order in which every entry except `i` is the same object, entry `i` has the fresh verdict and keeps the original link (spans), and the set of unchecked Patch links is unchanged.
**Validates: Requirements 3.5, 6.10**

### Property 15: A graveyard's address round-trips and never carries a document

For any valid `owner/name` or http(s) page URL and any unrelated parameters, `parseScanParams(searchAfterScan(search, {address}).search)` returns that repo or URL, and the unrelated parameters are unchanged. For a `text` origin the scan parameters are removed, unrelated ones stay, and the result is not shareable. Precedence is sample > repo > url.
**Validates: Requirements 6.12, 6.13**

### Property 16: host parts join back to the host
For any host string, `hostParts` (`web/host-parts.ts`) returns parts that join back to exactly that host, each part except the last ends with a dot, and no part other than the last contains another dot, so a label can break only after a dot.
**Validates: Requirements 6.2**

### Property 17: mist opacity stays in range and follows what is unjudged

For any `total`, `judged` and `restless`, `mistOpacity` (`web/mist.ts`) is in [0, 1]. With `restless` fixed it never rises as `judged` grows, and with `judged` fixed it never falls as `restless` grows. Total 0 gives 1.
**Validates: Requirements 6.1, 6.7**

### Property 18: Balanced parentheses survive extraction and patching

For any URL with 0 to 3 balanced parenthesis groups (possibly nested) placed in `[text](url)`, with or without a title, `extract` returns exactly that URL with one span whose slice equals the URL, and `patch` with a `dead` judgement and a resurrection changes only that span: the output equals `source.slice(0, start) + resurrection + source.slice(end)`.

**Validates: Requirements 1.1, 1.2, 4.2**

### Property 19: One final judgement per URL

For any list of distinct URLs whose archive answers are always fine, unavailable once, or always unavailable, the CLI `--json` output lists exactly those URLs in document order, once each. A link that was unavailable once carries the resurrection of the second answer; a link that is always unavailable is asked exactly once more and keeps `archiveUnavailable`.

**Validates: Requirements 3.3, 3.4, 7.2**

### Property 20: The result headline states the counts and the grammar is right

For any counts of alive, dead, possessed and restless judged links, any number of failed links and any `fixable ≤ dead + possessed`, `resultHeadline` (`web/result-headline.ts`) never contains "1 links" or "1 are", states `gone of judged` and `fixable` (or "None") when something is gone, states "All {judged}" when nothing is gone and restless is 0, states "{alive} links still lead where they should." when nothing is gone and restless > 0 (or just "None could be judged." when alive is 0), never contains "All" when restless > 0, ends with "{restless} could not be judged." when restless > 0 and something is alive or gone, starts with "{judged} of {total} links judged." when links failed, and `gone + alive + restless === judged`.
**Validates: Requirements 6.15, 6.17**

## Error Handling

| Failure | Behaviour |
|---|---|
| Input page or repo cannot be fetched, or content type undetectable | 422 `{ error }` from Worker; CLI stderr + exit 2; nothing scanned |
| Wayback unreachable, HTTP error, bad reply, or times out (10 s) | Verdict retained; Epitaph `'unavailable'` (not cached); no resurrection; `archiveNote` = "The archive could not be reached. Try again." |
| Wayback answers with no 200 capture | Verdict retained; Epitaph `'none'`; no resurrection; `archiveNote` = "Lost: never archived" |
| 429 from Wayback | Wait `Retry-After` (capped 10 s), retry once; on second failure Epitaph `'unavailable'` |
| URL rejected by `guard` | Verdict `restless` with rejection reason; no outbound request |
| Response body exceeds 512 KB | Reading stops at 512 KB; truncated body treated as full response; not an error |
| `--fix` on a URL input | Error to stderr (JSON when `--json` set); exit 2 |
| `check_links` with no URLs | MCP error response |
| Redirect target fails `guard` | Verdict `restless` with rejection reason |
| 5xx after retry | Verdict `restless` with `Answers {status}, twice. Not judged.` reason |

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

