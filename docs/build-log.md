# Build log

This is how Revenant was built with Kiro, for the Kiroween 2026 write-up. Every statement names a file or a commit in this repository. Where the repository holds no record, the log says so. Nothing here comes from session transcripts, because none are stored. Hashes are short git hashes. "Working tree" means the change was present on disk but not yet committed when this log was written (checked with `git status`).

The repository has 7 commits, all by the same author, from 16 to 25 November 2026:

| Commit | Date | Message | What it contains |
|---|---|---|---|
| `eb2da05` | 2026-11-16 | initial commit | `.kiro/steering/` (4 files), `.kiro/hooks/quality.json`, `.kiro/agents/gravekeeper.md`, `docs/brief/` (calibration, design-brief, requirements, task-outline), `docs/GUIA-KIRO.es.md`, `docs/submission.md`, `samples/haunted-readme.md`, `README.md`, `LICENSE`, `.gitignore` |
| `fe01f16` | 2026-11-16 | specs | `.kiro/specs/revenant/` (requirements, design, tasks, `.config.kiro`), `.kiro/hooks/post-task-test.json`, `docs/brief/spec-review.md`, `.kiro/steering/tech.md` change |
| `4453677` | 2026-11-16 | spec changes | Rewrite of design, requirements and tasks; `post-task-test.json` reformatted |
| `23071f4` | 2026-11-18 | tasks 1-12: core, network, worker, web, cli, mcp | 59 files: all of `src/`, `web/`, `test/`, `package.json`, `wrangler.toml`, `vitest.config.ts`, `tsconfig*.json`, `.kiro/settings/mcp.json` |
| `3323b15` | 2026-11-25 | feat(revenant): implement full snapshot classification pipeline with DNS confirmation | 51 files: web rewrite from `docs/design/canvas`, DNS confirmation, README, screenshots, font, `scripts/dev.mjs` |
| `e404afa` | 2026-11-25 | refactor(cli,mcp): rename entry point modules for clarity | `src/cli/index.ts` to `run.ts`, `src/mcp/index.ts` to `server.ts` |
| `b51ae89` | 2026-11-25 | feat(core,net,web): implement link classification pipeline with DNS confirmation and budget constraints | 50 files: `lives.ts`, `judge-link.ts`, `github-readme.ts`, `read-capped.ts`, CLI and MCP entry files, `web/graveyard.ts`, `web/yard-columns.ts`, favicon, og image, many tests |

The commit messages describe the commit, not individual spec tasks. The mapping from tasks to commits below is made from the files each commit touches.

## Inputs

`docs/brief/` and `docs/design/` were written with another AI assistant, Claude, before Kiro was used. `README.md` (section "Built with Kiro") states this: the brief and the UI reference were written with Claude, and Kiro generated the spec and all application code.

- `docs/brief/requirements.md`, `design-brief.md`, `task-outline.md`, `calibration.md`: the brief (all in `eb2da05`). `calibration.md` holds measured behaviour of real links that the spec and the gravekeeper agent refer to.
- `docs/brief/spec-review.md` (`fe01f16`): a review of the first generated spec, dated 16 Nov 2026. Its first item says possessed links must be patched, not only dead ones.
- `docs/design/canvas/project/Main.dc.html` and `canvas.json` (`3323b15`): the UI reference that task 14.8 translated into `web/`. The three `docs/design/night-*.jpg` files are untracked in the working tree.
- `docs/GUIA-KIRO.es.md` and `docs/submission.md` (`eb2da05`) are the author's notes and a Devpost draft. `submission.md` says its `[FILL]` markers must come from this log.

## Steering

All four files are in `.kiro/steering/` (added in `eb2da05`). `tech.md`, `structure.md` and `product.md` have `inclusion: always`; `costume.md` has `inclusion: fileMatch` with `web/**/*`.

- **`product.md`** decides what the product is and its principles. "**Never cry wolf.** A false "dead" costs trust. When unsure, the verdict is `restless`." It shaped `src/core/classify.ts` (no path from a 401, 403, 429, timeout or 5xx to `dead`) and Property 6 in `test/classify.prop.test.ts`. Task 14.1 later made non-DNS network errors `restless` for the same reason. "**One engine, three doors.**" shaped `src/net/judge-link.ts`, which the Worker (`src/worker/index.ts`) and `scan` (used by `src/cli/run.ts` and `src/mcp/server.ts`) all call; task 15.3 removed the Worker's own copy.
- **`tech.md`** decides stack, services and limits. "`src/core` is pure: no `fetch`, no `Date.now()`, no globals." `src/core` contains no network call (the only match for `fetch` is a comment in `src/core/classify.ts`), and `Fetcher` and `Wayback` are interfaces in `src/core/types.ts`, so `test/scan.int.test.ts` and the property tests inject fakes. The Cloudflare free-plan section ("at most 3 URLs") led to `PER_URL_WORST_CASE` in `src/net/judge-link.ts` and `test/worker-budget.test.ts`. The file was edited after its first commit (`fe01f16`, `b51ae89`).
- **`structure.md`** decides folders and imports. "`core` imports nothing of ours." holds for `src/core`. "A property test file names the property it checks" is followed, for example the first line of `test/host-parts.test.ts` is `// Property 16: host parts join back to the host`. The file is not fully current: it still lists `POST /api/scan (SSE stream)` and `web/main.ts`, which do not exist (the scan returns plain JSON, see `tech.md`; the entry is `web/graveyard.ts`), and it says "no `index.ts` barrels" while `src/core/index.ts` and `src/net/index.ts` exist.
- **`costume.md`** decides the UI. "Status is never colour-only: each verdict has its shape and a text label." It shaped `web/scene.ts` (lit window, tombstone, hand, fog, each with a label) and Property 11 (tombstone height) in `test/scene.prop.test.ts`. `costume.md` changed in `b51ae89`, and the working tree has one more change: the epitaph example now reads "copy from 14 Mar 2016" and explains that the copy is stepped back from the end of the life (task 16.1).

## Spec

The spec is in `.kiro/specs/revenant/`. `.config.kiro` records `"workflowType": "requirements-first"`. `requirements.md` has 8 requirements (extract, judge, epitaph and resurrection, patch, safe fetching, graveyard, CLI, MCP), with more acceptance criteria added during sections 14 to 16. `tasks.meta.json` holds `pbtResults` (7 entries) and `executionHistory` (312 entries across 93 task keys, each with an execution id, chat session id and timestamp). It is the only file that records that tasks were run by Kiro; it does not record what was said.

Sections 14, 15 and 16 came from reviews of the running app. According to the author, those reviews were written with Claude and given to Kiro as instructions. No file in the repository records this; the task texts only show their content.

### 1. Scaffold project structure and tooling
Specified: `package.json` (ESM, scripts), strict `tsconfig.json`, `tsconfig.web.json`, `wrangler.toml`, folder skeleton, `vitest.config.ts`. Produced: those files, in `23071f4`.

### 2. Core types and URL guard
Specified: the types, `guard` (scheme, credentials, IP literals in every notation, local host names), unit tests and Property 7. Produced: `src/core/types.ts`, `src/core/guard.ts`, `test/guard.test.ts`, `test/guard.prop.test.ts` (`23071f4`).

### 3. Link extraction
Specified: `extract` for four Markdown forms and HTML `href`, byte spans, fenced-block exclusion, deduplication; Properties 4 and 9. Produced: `src/core/extract.ts`, `test/extract.test.ts`, `test/extract.prop.test.ts` (`23071f4`).

### 4. Similarity, visible text, and verdict classification
Specified: a tag-stripping `visible-text`, Jaccard `similarity` over 3-word shingles, registrable-domain helper, `classify` as a decision table; Properties 5 and 6. Produced: `src/core/visible-text.ts`, `similarity.ts`, `domain.ts`, `classify.ts` and their tests (`23071f4`).

### 5. Document patching
Specified: `patch` replaces URL spans of dead or possessed links that have a resurrection, right to left; Properties 1, 2, 3, 8. Produced: `src/core/patch.ts`, `test/patch.test.ts`, `test/patch.prop.test.ts` (`23071f4`).

### 6. Network layer
Specified: guarded fetcher with manual redirects, 8 s timeout and 512 KB cap; Wayback client with cache and 429 back-off; `scan` as an async generator with a pool of 6; Properties 9 and 10 at scan level. Produced: `src/net/fetcher.ts`, `wayback.ts`, `scan.ts`, `test/wayback.test.ts`, `test/scan.int.test.ts`, `test/scan.prop.test.ts` (`23071f4`).

### 7. Checkpoint, core and network complete
Specified: run `npm test` and `npm run check`. No files.

### 8. Worker HTTP API
Specified: Hono app with `POST /api/scan` (at most 3 URLs, 1 MB body limit) and `POST /api/resolve`; `[assets]` in `wrangler.toml`. Produced: `src/worker/index.ts`, `wrangler.toml` (`23071f4`).

### 9. Graveyard UI
Specified: page shell, in-browser extraction and batching, SVG scene with one shape per verdict, ledger and patched download, accessibility pass; Property 11. Produced: `web/index.html`, `web/graveyard.ts`, `web/scene.ts`, `web/styles.css`, `test/scene.prop.test.ts` (`23071f4`).

### 10. CLI
Specified: `revenant <file|url> [--fix] [--json]`, exit 1 on dead or possessed, `bin` entry and an esbuild step. Produced: `src/cli/index.ts` (later `run.ts`), `test/cli.int.test.ts` (`23071f4`).

### 11. Checkpoint, all surfaces wired
Specified: run `npm test` and `npm run check`. No files.

### 12. MCP server
Specified: stdio server with `check_links` and `resurrect`, tests, an esbuild step, registration in `.kiro/settings/mcp.json`. Produced: `src/mcp/index.ts` (later `server.ts`), `test/mcp.int.test.ts`, `.kiro/settings/mcp.json` (`23071f4`).

### 13. Ship
Specified: deploy, check the sample shows all four verdicts on the live Worker, write the README. The repository holds the README with screenshots (`README.md`, `docs/screenshots/*.png`, `3323b15`). It holds no record of the deploy or of the live run beyond the production URL in the README and the checked boxes. `tasks.md` lists 13 after 14 and the dependency graph in it schedules 13.1 to 13.3 after 14.12.

### 14. Rework after the first local run
Specified: 14.1 DNS confirmation so only NXDOMAIN is `dead`; 14.2 one scene renderer and a bundled sample; 14.3 full-width layout; 14.4 `npm run dev` runs Vite and `wrangler dev`; 14.5 plain-sentence reasons from `classify`; 14.6 port of an HTML mockup; 14.7 distinguish "never archived" from "archive unreachable"; 14.8 port of `docs/design/canvas/project/Main.dc.html`; 14.9 HTTP 530 from Workers as a DNS signal; 14.10 investigate a codeplex.com difference between production and local; 14.11 replace two sample links; 14.12 polish.
Produced (`3323b15`): `src/net/dns.ts`, `src/net/retry.ts`, `src/core/archive-note.ts`, `scripts/dev.mjs`, `test/dns.test.ts`, `test/worker-530.test.ts`, `test/fetcher.test.ts`, the rewritten `web/` files, `web/fonts/`, `vite.config.ts`. The old `test/guard-smoke*.mjs`, `test/guard-smoke-runner.ts` and `test/guard-debug.ts` were deleted there (14.7). `docs/design/graveyard.html` no longer exists (14.8). `package.json` has `"engines": { "node": ">=22" }` (14.12).
What was redone, from `tasks.md`: 14.3 (a layout rework) was superseded by 14.6 (port of an HTML mockup; its text says "Supersedes 14.3"), and 14.6 was in turn followed by 14.8, which ports a different design file (`Main.dc.html`) over the 14.6 wiring and deletes the mockup. The dependency graph shows 14.3 in wave 18, 14.6 in wave 19 and 14.8 in wave 21. 14.10 asks for a report before any rule change. Its outcome is not stated in a file; `test/scan.int.test.ts` has a test named "archive unreachable → restless; no capture → alive (unchanged)".

### 15. Review fixes (wrong results, first impression, honesty)
Specified: 15.1 one CDX request per URL and a pure function choosing the longest continuous life; 15.2 `owner/repo` input with a rate-limit fallback; 15.3 one per-link pipeline; 15.4 split CLI and MCP into logic and entry files; 15.5 empty state; 15.6 balanced yard columns; 15.7 `/api/resolve` through the shared fetcher; 15.8 Worker subrequest budget; 15.9 favicon and Open Graph tags; 15.10 cleanup and User-Agent; 15.11 CLI streams its lines; 15.12 README honesty; 15.13 epitaph and resurrection from one archive answer.
Produced (`b51ae89`, `e404afa`): `src/core/lives.ts` and `test/lives.prop.test.ts`, `src/net/github-readme.ts`, `src/net/judge-link.ts` and `test/judge-parity.test.ts`, `src/cli/main.ts`, `src/mcp/main.ts`, `src/net/read-capped.ts`, `src/net/user-agent.ts`, `web/yard-columns.ts` and `test/yard-columns.prop.test.ts`, `web/public/favicon.svg`, `web/public/og.png`, `test/worker-budget.test.ts`, `test/worker-resolve.test.ts`, `test/judge-archive.test.ts`.
What went wrong, from `tasks.md`: 15.12 was marked done, but its README text was not in the file; task 16.7 exists to "Finish 15.12" and lists four README lines still wrong. 16.7 is marked in progress (`[-]`) in `tasks.md`. The README in the working tree now contains the Claude statement and the Pew Research citation.

### 16. Production review fixes
Specified: 16.1 resurrection steps back from the end of a life and the stone keeps the whole life; 16.2 repository README from `raw.githubusercontent.com` before the API; 16.3 "Ask again" and an automatic retry; 16.4 sticky inscription band; 16.5 host labels break after dots; 16.6 a scan has a shareable address (`?repo=`, `?url=`); 16.7 finish the README fixes and retake screenshots; 16.8 this hook and this log.
Files, all in the working tree and not in any commit: modified `src/core/lives.ts`, `src/core/types.ts`, `src/net/github-readme.ts`, `src/net/judge-link.ts`, `src/net/wayback.ts`, `src/worker/index.ts`, `web/graveyard.ts`, `web/styles.css`; new `web/ask-again.ts`, `web/host-parts.ts`, `web/scan-address.ts`, `test/ask-again.test.ts`, `test/archive-flag.test.ts`, `test/host-parts.test.ts`, `test/scan-address.prop.test.ts`, `test/lives-real-data.test.ts`, `test/fixtures/cdx-{dmoz,freebase,codeplex,geocities}.json`. 16.8 added `.kiro/hooks/link-guard.json` and `scripts/check-sample.mjs`.
`design.md` Property 16 ("host parts join back to the host") was added during 16.8, because the test already carried that number and design.md stopped at 15. The `Wayback` interface in `design.md` was updated to the one in `src/core/types.ts` (`getArchive`, `getSnapshotText(url, archive?)`, `getClosestSnapshot?`).

## Hooks

Hook files are in `.kiro/hooks/`. Hook runs are not recorded in the repository, so this log does not claim what any hook caught.

| File | Hook | Trigger | Matcher | Action | Purpose |
|---|---|---|---|---|---|
| `quality.json` (`eb2da05`) | Typecheck on save | `PostFileSave` | `\.ts$` | command `npx tsc --noEmit` | Type errors surface when a TypeScript file is saved. |
| `quality.json` | Core change needs its property | `PostFileSave` | `src/core/.*\.ts$` | agent prompt | Keep `src/core` pure and its property tests in step with `design.md`. |
| `quality.json` | Costume check | `PostFileSave` | `web/.*\.(ts\|css\|html)$` | agent prompt | Check web changes against `costume.md` (never colour-only, reduced motion, keyboard path). |
| `post-task-test.json` (`fe01f16`, reformatted in `4453677`) | Test suite after spec task | `PostTaskExecution` | none | command `npm test 2>&1`, `feedbackOnFailure: true` | Run the tests after a spec task and return failures to the agent. |
| `link-guard.json` (working tree, 16.8) | README links stay alive | `PostFileSave` | `^README\.md$` | command `npx tsx src/cli/main.ts README.md 2>&1`, `feedbackOnFailure: true` | Run Revenant's CLI from source on the root README. Exit 1 on a dead or possessed link; restless links are printed but do not fail. |
| `link-guard.json` | Sample verdicts match their comment | `PostFileSave` | `^samples/.*\.md$` | command `node scripts/check-sample.mjs 2>&1`, `feedbackOnFailure: true` | Print only links whose verdict differs from the expected-verdicts comment at the end of the sample; exit 1 if any. |

`scripts/check-sample.mjs` runs the CLI with `--json` on every `samples/*.md` that has an expected-verdicts comment. A link listed as "occasionally restless" (kiko.com in `samples/haunted-readme.md`) matches either verdict. Whether Kiro applies a matcher to a workspace-relative or absolute path is not documented in this repository.

## Agents and MCP

- `.kiro/agents/gravekeeper.md` (`eb2da05`) defines a read-only reviewer. Its text: it never writes or edits files; it runs `npm run check` and `npm test`, reads the changed files, and answers with a verdict (ACCEPT or REJECT) and checks for the spec, "never cry wolf" against `docs/brief/calibration.md`, purity of `src/core`, guarded fetching, property tests that could fail, and (for web changes) costume rules. Its shell permissions are limited to `npm test*`, `npm run check*` and `git diff/status/log*`.
- `.kiro/settings/mcp.json` (`23071f4`) registers Revenant's own MCP server in Kiro as `revenant`, started with `node ./dist/mcp/index.js`, so an agent can call `check_links` and `resurrect` while it works. The path is produced by `npm run build:mcp`; `dist/` is in `.gitignore`.
- Evidence of use: none in the repository. There is no gravekeeper report, no file showing an MCP call, and `tasks.meta.json` records task executions without naming agents or tools. This log does not claim either was used.

## Verification

`npm test` (`vitest run`) was run when this log was written:

```
 Test Files  38 passed (38)
      Tests  422 passed (422)
```

`npm run check` (`tsc --noEmit`) and `npx tsc -p tsconfig.web.json --noEmit` both exit 0. The `test/` folder has 38 test files: 11 `*.prop.test.ts` (fast-check), 3 `*.int.test.ts` (`cli`, `mcp`, `scan`) and 24 other unit test files, plus `test/fixtures/` and `test/url-check.mjs`.

Correctness properties in `.kiro/specs/revenant/design.md`:

1. Patch touches only link targets
2. The living are left alone
3. Patch is idempotent
4. Extraction round-trips
5. Similarity is a proper measure
6. Never cry wolf
7. The guard holds
8. Excluded links survive the patch unchanged
9. Deduplication invariant
10. Concurrency cap invariant
11. Tombstone height formula
12. The chosen life is the longest continuous one
13. Yard columns are balanced
14. Ask again replaces one judgement and nothing else
15. A graveyard's address round-trips and never carries a document
16. host parts join back to the host

Commands in `package.json`:

| Script | Command |
|---|---|
| `dev` | `node scripts/dev.mjs` (Vite and `wrangler dev`) |
| `dev:web` / `dev:api` | `vite` / `wrangler dev --ip 127.0.0.1 --port 8787` |
| `build:cli` | `esbuild src/cli/main.ts --bundle --platform=node --format=esm --outfile=dist/cli/index.js` |
| `build:mcp` | `esbuild src/mcp/main.ts ... --outfile=dist/mcp/index.js` |
| `build` | `build:cli`, `build:mcp`, `vite build` |
| `test` | `vitest run` |
| `check` | `tsc --noEmit` |
| `deploy` | `build:cli`, `build:mcp`, `vite build`, `wrangler deploy` |

## What is not in this log

- Session transcripts. The repository stores none; `tasks.meta.json` keeps only ids and timestamps.
- Timings. No file records how long any task or session took.
- Hook run logs. Nothing records when a hook fired or what it returned.
- The text of the Claude reviews behind sections 14 to 16 and of the brief. Only the author's account and the README statement say they exist.
- The deploy itself (13.1) and the production runs behind the screenshots.
