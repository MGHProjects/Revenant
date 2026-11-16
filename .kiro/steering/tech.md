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
- Wayback CDX: `https://web.archive.org/cdx/search/cdx?url={u}&output=json&fl=timestamp,statuscode&filter=statuscode:200&limit=1`
  (`limit=1` = first good capture, `limit=-1` = last good capture)
- Raw snapshot body (no Wayback toolbar): `https://web.archive.org/web/{timestamp}id_/{u}`

Be a polite client: descriptive User-Agent, at most 6 concurrent requests, cache Wayback answers
with the Workers Cache API for 24 h, back off on 429.

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
