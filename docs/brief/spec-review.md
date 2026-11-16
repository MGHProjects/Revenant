# Spec review — 16 Nov 2026

External review of `.kiro/specs/revenant/` against the steering files and `calibration.md`.
No code exists yet, so every item is cheap to fix now. Ordered by damage if left alone.

## Must fix before running any task

1. **Possessed links are never repaired.** Requirements 4.1, 4.3, 6.5, 6.6, 7.4 and `patch()` in the
   design say "`dead` Link". They must say "`dead` or `possessed` Link that has a Resurrection".
   Possessed links are the product's main claim; the patch must fix them. Requirement 6.3 (epitaph
   on the grave) must cover `possessed` too.

2. **The costume was dropped.** Requirement 6.2 and the design render every verdict as a tombstone,
   and give `possessed` and `restless` the same shape. That contradicts
   `.kiro/steering/costume.md` and the requirement's own "distinct shape per status". Required:
   lit window = `alive`, tombstone = `dead`, hand rising from the ground with green glow =
   `possessed`, fog patch = `restless`. The moon waxes with progress (received / total).
   Task 9.1 points to `docs/brief/design-brief.md` for the palette; the palette is in `costume.md`.

3. **The UI is in the wrong folder, so its steering and hook never fire.** The spec puts the page
   in `src/worker/static/` built with esbuild. `structure.md` and `tech.md` say `web/` built with
   Vite. `costume.md` loads on `web/**/*` and the "Costume check" hook matches `web/`. Move the UI
   to `web/` and follow the steering. Also: `wrangler.toml` must use `[assets]`, not the legacy
   `[site]` bucket; `visibleText.ts` must be `visible-text.ts` (kebab-case rule); the web
   tsconfig needs the `DOM` lib.

4. **All 17 test tasks are optional (`*`).** The property tests are the correctness evidence for
   this project. Make every property-test task (2.4, 3.3, 4.4, 4.8, 5.3, 6.5, 6.6, 9.4) and the
   `scan` integration test (6.7) mandatory.

5. **The guard got weaker.** The brief rejected every IP-literal host. The spec now allows public
   IP literals and lists private ranges, which misses `0.0.0.0`, `100.64.0.0/10`, `fe80::/10`,
   IPv4-mapped IPv6 (`::ffff:127.0.0.1`) and integer/hex forms (`http://2130706433/`). A Worker
   cannot "resolve" hosts either. Go back to: reject any host that is an IP literal in any form.
   Update Property 7 to match.

6. **Oversized pages become errors.** Requirement 5.3 discards a body over 512 KB and "reports a
   body-size error", and invents reporting two errors at once. `Probe` has no field for that, and
   no verdict is defined, so a large healthy page could end up `dead`. Change to: read the first
   512 KB, stop reading, and treat the response normally.

7. **Cloudflare free-plan limits break the scan.** Checked on the Cloudflare limits page today:
   free plan allows 50 subrequests and 10 ms CPU per request; paid allows 10,000 and 5 min. One
   scan of 200 links needs 200+ fetches plus redirects plus Wayback calls. **Decided: stay on the free
   plan and scan in batches.** The rules are in `.kiro/steering/tech.md` under "Cloudflare free
   plan": the browser extracts, `/api/scan` takes at most 3 URLs and returns JSON (no SSE), 2
   batches in flight. Rewrite Requirement 6.1, the Worker API, the SSE payloads and tasks 8–9 to
   match. The pool-of-6 property (Property 10) now applies to `scan` on Node (CLI and MCP).

## Should fix

8. **`patch` must stay pure.** Requirement 4.4 says the system "re-evaluates each link fresh at
   patch time". `patch` does no I/O. Reword: patching an already patched document, in which the
   Wayback URLs are judged `alive`, returns it unchanged.

9. **Wayback is not injectable.** `scan(input, kind, fetcher, now)` has no way to fake the Wayback
   client, yet the integration test promises "no real network". Have the Wayback client use the
   injected `Fetcher` (or inject a `Wayback` interface).

10. **Snapshot text URL lost `id_`.** Design uses `web.archive.org/web/{ts}/{url}`, which returns
    the page rewritten by the Wayback Machine. `tech.md` has the right form:
    `web.archive.org/web/{ts}id_/{url}`. Build the Resurrection URL from the CDX "last" timestamp
    already fetched for the Epitaph instead of a third call to the availability API.

11. **Persistent 5xx is reported `dead`.** This came from the brief, and it is a risk for "never
    cry wolf": outages and bot challenges return 503. Safer: 5xx after the retry is `restless`
    with reason `503 after retry`; only DNS failure, 404 and 410 are `dead`. Update Property 6.

12. **`scan` output type is undefined.** It "yields Judgements", "emits meta" and "yields an
    error". Define one union, e.g. `ScanEvent = { type: 'meta' … } | { type: 'judgement' … } |
    { type: 'error' … }`. `MetaEvent` has `capLimit` in one place and not the other.

13. **The 1 MB body limit is not enforced by the Worker runtime.** Task 8.1 must check it in code.

## Housekeeping

- `.kiro/hooks/post-task-test.json` starts with a UTF-8 BOM; a strict JSON parser rejects it.
  Confirm in the Hooks panel that it is listed and that it fires after a task. It uses
  `PostTaskExecution` and `feedbackOnFailure`, neither of which is in the hook schema page
  (which shows `PreTaskExec`). It will also fail until task 1 creates `package.json`.
- The spec and the new hook are not committed.
