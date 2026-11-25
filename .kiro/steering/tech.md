---
inclusion: always
---

# Tech

- **Language:** TypeScript, strict. Node 22+. ESM only.
- **Runtime:** one Cloudflare Worker (Hono) serving the API and the static web build. One deploy.
- **Web:** Vite + vanilla TypeScript + CSS. No UI framework, no component library, no Tailwind.
  Graphics are inline SVG and CSS. No image or font downloads except one self-hosted display font.
- **Tests:** Vitest + fast-check. Every Correctness Property in the spec is a fast-check test.
- **CLI / MCP:** Node entry points over the same core. MCP uses `@modelcontextprotocol/sdk` (stdio).
- **Dependencies:** add one only when the platform cannot do the job in ~20 lines. Ask first.

## External services (free, no key)

- Wayback availability: `https://archive.org/wayback/available?url={u}&timestamp={yyyymmdd}`
- Wayback CDX (one request per URL): `https://web.archive.org/cdx/search/cdx?url={u}&output=json&fl=timestamp,length&filter=statuscode:200&collapse=timestamp:6`
  (one good capture per month, oldest first; `src/core/lives.ts` picks the longest continuous life)
- Raw snapshot body (no Wayback toolbar): `https://web.archive.org/web/{timestamp}id_/{u}`

Be a polite client: descriptive User-Agent, at most 6 concurrent requests, cache Wayback answers
for 24 h (in memory, see the budget below), back off on 429.

## Cloudflare free plan (decided 16 Nov 2026)

The Worker runs on the free plan: **50 subrequests and 10 ms CPU per request**. So:

- The browser runs `extract` itself (core is pure and bundled) and owns the 200-link cap.
- `POST /api/scan` takes `{ urls: string[] }` with **at most 3 URLs** and returns
  `{ judgements: Judgement[] }` as plain JSON. No SSE. Worst case per URL is 16 subrequests (2 attempts × 6 hops + CDX 2 + `id_` 2, each with one 429 retry),
  so 3 URLs use 48 of 50. Every fetch counts, **Cache API `match`/`put` calls count too** and share the same 50,
  so the Worker makes none and caches Wayback answers in memory only. `src/net/judge-link.ts` exports `PER_URL_WORST_CASE`.
- The browser sends 2 batches at a time (6 links in flight). Graves rise as batches return.
- Resolving a page URL or `owner/repo` into source text is its own endpoint, `POST /api/resolve`.
- `similarity` runs only on the first 64 KB of visible text of each side, to stay inside 10 ms CPU.
  `// shortcut: fixed 64 KB cap, raise it if the Worker is moved to the paid plan.`
- CLI and MCP run on Node with no such limits and use `scan` with a pool of 6 directly.

## Non-negotiable rules

- `src/core` is pure: no `fetch`, no `Date.now()`, no globals. Network goes through an injected
  `Fetcher`; time is passed in. This is what makes property tests possible.
- The Worker fetches attacker-chosen URLs. Before any outbound request: scheme must be http/https,
  no credentials in the URL, host must not be an IP literal, `localhost`, `*.local`, `*.internal`
  or `*.localhost`. Timeout 8 s, body cap 512 KB, max 5 redirects, each hop re-validated.
- A scan is capped at 200 links. Say so in the UI when the cap is hit.
- Never log full user documents.

## Commands

- `npm run dev` — Vite + `wrangler dev`
- `npm test` — Vitest (unit + property), must pass before a task is marked done
- `npm run check` — `tsc --noEmit`
- `npm run deploy` — build web, `wrangler deploy`
