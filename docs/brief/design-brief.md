# Design brief — Revenant

Input for the design phase in Kiro. Kiro writes its own `design.md` and extracts its own properties; the ones below are the invariants it must not lose.

## Overview

A pure core decides everything; thin doors (Worker, CLI, MCP) feed it and show its output.

```
 web ──SSE──▶ worker ─┐
 cli ─────────────────┼─▶ scan(input, fetcher, now) ─▶ net (fetcher, wayback) ─▶ internet
 mcp ─────────────────┘            │
                                   └─▶ core (extract, guard, classify, similarity, patch)
```

## Types (`src/core/types.ts`)

```ts
type Verdict = 'alive' | 'dead' | 'possessed' | 'restless';
interface Link { url: string; spans: Array<{ start: number; end: number }> }
interface Probe {                      // what the network saw; input to classify()
  outcome: 'response' | 'network-error' | 'timeout';
  status?: number; finalUrl?: string; text?: string;
}
interface Epitaph { first: string; last: string }            // ISO dates
interface Judgement {
  link: Link; verdict: Verdict; reason: string;
  epitaph?: Epitaph | 'unavailable'; resurrection?: string;  // snapshot URL
}
type Fetcher = (url: string, init?: { timeoutMs: number; maxBytes: number }) => Promise<Probe>;
```

## Core functions (all pure)

| Function | Does |
|---|---|
| `extract(source, kind)` | Markdown/HTML → `Link[]` with byte spans, deduplicated by URL |
| `guard(url)` | `ok` or a rejection reason (Requirement 5.1) |
| `similarity(a, b)` | Jaccard index over 3-word shingles of visible text, in `[0, 1]` |
| `classify(probe, snapshotText?)` | `{ verdict, reason }` per Requirement 2 |
| `patch(source, judgements, excluded)` | New source with resurrectable spans replaced |

`visibleText(html)` strips tags, scripts and styles with a small tokenizer; no DOM dependency.

## Scan flow (`src/net`)

1. `extract` → cap 200 → `guard` each (rejected links become `restless` with the reason).
2. Pool of 6: `fetcher(url)` → only if 2xx **and** the final registrable domain differs from the
   requested one, fetch the last Snapshot text → `classify`. Alive same-host links cost zero
   Wayback calls.
   `// shortcut: registrable domain = last two labels plus a short list of two-level suffixes
   (co.uk, com.au, …); switch to the Public Suffix List if a false verdict is traced to it.`
3. For `dead`/`possessed`: CDX first + last → Epitaph; availability API → Resurrection.
4. Yield each `Judgement` as it completes (async generator). The Worker forwards it as an SSE event;
   the CLI and MCP collect it.

Wayback calls are cached 24 h (Cache API in the Worker, in-memory map elsewhere).
429 from Wayback → wait `Retry-After` (max 10 s) once, then Epitaph `unavailable`.

## API

`POST /api/scan` body `{ source: string, kind: 'markdown' | 'html' | 'url' | 'repo' }`
→ `text/event-stream`: `event: meta` (total, capped), `event: judgement` ×N, `event: done`.
Body limit 1 MB. Errors are a JSON `{ error }` with 4xx, never a stack trace.

## Web

`graveyard.ts` keeps one array of `Judgement` and renders it twice: SVG scene and `<table>` ledger.
Grave x-position follows link order in the document; height = `clamp(lifespanYears * 12px, 40, 220)`.
Patching happens in the browser with the same `patch()` from core; download via Blob.

## Error handling

| Failure | Behaviour |
|---|---|
| Input page/repo cannot be fetched | 422 with the reason; nothing is scanned |
| Wayback down | Verdicts still returned; Epitaph `unavailable`; UI says "the archive is silent" |
| SSE connection drops | UI keeps what arrived and offers "resume" (rescan of the missing URLs) |

## Correctness Properties

Each is a fast-check test in `test/*.prop.test.ts`.

**Property 1: Patch touches only link targets.** For any source and any judgements, removing all
link spans from `source` and from `patch(source, …)` yields identical strings.
*Validates: Requirement 4.2*

**Property 2: The living are left alone.** For any source where every verdict is `alive` or
`restless`, `patch(source, …) === source`.
*Validates: Requirement 4.3*

**Property 3: Patch is idempotent.** `patch(patch(s)) === patch(s)` when the second pass re-extracts
links and judges Wayback URLs as `alive`.
*Validates: Requirement 4.4*

**Property 4: Extraction round-trips.** For any generated Markdown built from a known list of URLs,
`extract` returns exactly those URLs, and `source.slice(start, end)` equals the URL for every span.
*Validates: Requirements 1.1, 1.4, 1.5*

**Property 5: Similarity is a proper measure.** For any texts `a`, `b`: result is in `[0, 1]`,
`similarity(a, a) === 1` for non-empty `a`, and `similarity(a, b) === similarity(b, a)`.
*Validates: Requirement 2.4*

**Property 6: Never cry wolf.** For any `Probe` with status 401, 403, 429 or outcome `timeout`,
`classify` never returns `dead`. For any `Probe`, `classify` returns exactly one verdict and a
non-empty reason. For any `Probe` whose `finalUrl` has the same registrable domain as the requested
URL, `classify` never returns `possessed`.
*Validates: Requirements 2.3, 2.7, 2.8*

**Property 7: The guard holds.** For any URL whose host is an IPv4/IPv6 literal, `localhost`, or
ends in a blocked suffix, or whose scheme is not http/https, `guard` rejects.
*Validates: Requirement 5.1*

## Testing

- Unit tests with recorded `Probe` fixtures for each branch of `classify`.
- One integration test of `scan` with a fake `Fetcher` (no real network in CI).
- Manual: the sample document must show at least one of each verdict.

## Out of scope (v1)

Same-host "drift" detection (page replaced without a redirect — see `calibration.md` for why it
is not reliable yet), opening GitHub pull requests, accounts, scheduled rescans, crawling beyond one page.
