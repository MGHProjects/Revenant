# Revenant

**Find the dead and possessed links in any document, and bring them back from the Internet Archive.**

Built for [Kiroween 2026](https://kiroween.devpost.com/), category: Costume Contest.

## What it is

Pew Research Center found that 38% of web pages that existed in 2013 were no longer accessible
a decade later ([When Online Content Disappears](https://www.pewresearch.org/data-labs/2024/05/17/when-online-content-disappears/),
17 May 2024). Some links are worse than dead: the URL still
answers, but the domain was sold and now serves something else. A normal link checker reports
those as fine. Revenant gives every link in a Markdown or HTML document one verdict, shows when
it died, and replaces it with its closest archived snapshot from the Wayback Machine. The same
engine runs as a web app, as a CLI for CI, and as an MCP server for AI agents.

| Verdict | Shape on the page | Meaning |
|---|---|---|
| `alive` | Lit window | Answers 2xx. Content is compared with the archive only after a redirect to another registrable domain. |
| `dead` | Tombstone | Gone: a confirmed DNS failure (NXDOMAIN or no A/AAAA record) or a 404/410. |
| `possessed` | Green zombie hand | A cross-domain redirect whose content is under 20% like the chosen archive copy. |
| `restless` | Fog patch | Cannot tell: 401 (needs a login), 403 and 429, 5xx twice, timeout, other connection errors, blocked addresses, other statuses, and an archive that could not be reached for the comparison. |

A 5xx is never `dead`. Revenant never cries wolf: when it is not sure, the verdict is `restless`.

- **Web:** paste a document, a page address or `owner/repo`. Links rise as a graveyard. Download the patched file.
- **CLI:** `revenant README.md --fix`. Exits 1 when links are dead or possessed, so CI can fail on rot.
- **MCP:** `check_links` and `resurrect` tools, so an agent can verify a URL before it cites it.

## Try it

Open <https://revenant.mgh-web.workers.dev> and press **Scan the sample**. Or press **Load the
sample**, then **Scan the document**. Or open a link that scans on load:

- <https://revenant.mgh-web.workers.dev/?sample=1>
- <https://revenant.mgh-web.workers.dev/?repo=sindresorhus/awesome>
- <https://revenant.mgh-web.workers.dev/?url=http://info.cern.ch/hypertext/WWW/TheProject.html>

The sample is [`samples/haunted-readme.md`](samples/haunted-readme.md): nine links with every verdict.

In the graveyard:

- Select a grave to read its inscription. **See every capture** opens the full Wayback list for that link.
- **Ask again** re-checks one link, for example when the archive was unreachable the first time.
- **Copy link** copies the address of this scan, so someone else can open the same graveyard.

## Screenshots

The graveyard after scanning the sample, with the possessed `geocities.com` link selected:

![Graveyard at 1440 px wide: two lit windows, three tombstones, three green hands, one fog patch, and the inscription for geocities.com](docs/screenshots/graveyard-1440.png)

The same scene on a 390 px wide screen:

![Graveyard at 390 px wide, graves wrapped into three rows](docs/screenshots/graveyard-390.png)

The ledger below the scene holds the same data as a plain table, with the archived copy of each link and a checkbox to include it in the patch:

![Ledger table listing nine links with verdict, reason, archived copy date and patch checkbox](docs/screenshots/ledger-1440.png)

These screenshots come from the production site (https://revenant.mgh-web.workers.dev), on the sample document, taken on {date}.

## CLI

Build once, then run the bundle with Node 22 or newer:

```sh
npm install
npm run build:cli
node dist/cli/index.js <file|url|owner/repo> [--fix] [--json]
```

`package.json` declares a `revenant` bin that points at `dist/cli/index.js`, so `npm link` in this
folder puts a `revenant` command on your PATH. The examples below use that name.

The input is a URL (starts with `http://` or `https://`), an `owner/repo` pair (when no file with
that name exists), or a file path. Files ending in `.html` or `.htm` are read as HTML, anything
else as Markdown.

### Default output

One line per link that is not alive: `[verdict] url — reason (archived copy)`.

```console
$ revenant samples/haunted-readme.md
[dead] http://www.freebase.com/ — Answers 404. (https://web.archive.org/web/20160501004947/http://www.freebase.com/)
[dead] http://www.dmoz.org/ — The domain no longer resolves. (https://web.archive.org/web/20170301000315/http://www.dmoz.org/)
[possessed] http://www.geocities.com/SiliconValley/ — Redirects to yahoo.com; 0% like the archived page. (https://web.archive.org/web/19990202115713/http://www.geocities.com/SiliconValley/)
[restless] https://api.github.com/user — Answers 401: needs a login. Not judged. (—)
9 links: 2 alive, 3 dead, 3 possessed, 1 restless
```

(Excerpt. The last line is the summary, written to stderr.) Lines appear as each check finishes, so they follow the order the checks finish, not the order of the document. The summary always lists all four counts and says 1 link: for a single link. It is written to stderr in every mode.

### `--fix`

Overwrites the file, replacing each dead or possessed link that has an archived copy with the
snapshot URL. It prints `Patched N links in <file>` to stderr, then the summary line, and no per-link lines. `--fix` works
on files only; with a URL it prints an error and exits 2.

```console
$ revenant docs/links.md --fix
Patched 6 links in docs/links.md
9 links: 2 alive, 3 dead, 3 possessed, 1 restless
```

The exit code still reflects what was found before the patch, so the run above exits 1. Run the
check again without `--fix` to confirm.

### `--json`

Prints one JSON object on stdout at the end, with one entry per distinct link, in document order (by first span). Nothing is streamed; the summary still goes to stderr. `resurrection` and `epitaph`
are present only when known. `spans` are character offsets of the link in the source. This is an
excerpt for two of the nine sample links:

```json
{
  "links": [
    {
      "url": "http://www.google.com/reader/about/",
      "verdict": "dead",
      "reason": "Answers 404.",
      "resurrection": "https://web.archive.org/web/20210503140021/http://www.google.com/reader/about/",
      "epitaph": { "first": "2013-07-02", "last": "2021-05-03" },
      "spans": [{ "start": 634, "end": 669 }]
    },
    {
      "url": "http://www.geocities.com/SiliconValley/",
      "verdict": "possessed",
      "reason": "Redirects to yahoo.com; 0% like the archived page.",
      "resurrection": "https://web.archive.org/web/19990202115713/http://www.geocities.com/SiliconValley/",
      "epitaph": { "first": "1996-12-21", "last": "1999-10-09" },
      "spans": [{ "start": 774, "end": 813 }]
    }
  ]
}
```

`epitaph` can also be the string `"unavailable"` when the archive could not be reached.
`--json` can be combined with `--fix`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | No dead or possessed links. `alive` and `restless` do not fail the run. |
| 1 | At least one dead or possessed link, or the input file could not be read. |
| 2 | Usage error: no input given, or `--fix` used with a URL or `owner/repo`. |

### GitHub Actions

Revenant is not published to npm, so the job builds it from a checkout of this repository.

```yaml
name: links
on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:

jobs:
  revenant:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with:
          repository: MGHProjects/Revenant
          path: .revenant
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci && npm run build:cli
        working-directory: .revenant
      - run: node .revenant/dist/cli/index.js README.md
```

The last step fails the job (exit 1) when README.md has a dead or possessed link.

## MCP server

```sh
npm install
npm run build:mcp
```

This writes `dist/mcp/index.js`, a stdio server named `revenant`.

### Kiro

This repository already contains `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "revenant": {
      "command": "node",
      "args": ["./dist/mcp/index.js"]
    }
  }
}
```

### Other clients

Use the same `mcpServers` form in the client's config file, with an absolute path, because most
clients do not start the server from this folder:

```json
{
  "mcpServers": {
    "revenant": {
      "command": "node",
      "args": ["/absolute/path/to/Revenant/dist/mcp/index.js"]
    }
  }
}
```

### Tools

**`check_links`** checks links for rot.

- `text` (string, optional): Markdown containing links.
- `urls` (string array, optional): bare URLs. Used when `text` is empty or missing.
- Returns JSON text: `{ total, capped, capLimit, judgements }`. `capLimit` is 200, and `capped` is
  true when the input had more links than that. Each judgement has the link, `verdict`, `reason`,
  and, for dead or possessed links, `resurrection` and `epitaph`. An `archiveNote` string is added
  when the archive could not be reached or has no copy.
- Input with no URLs returns an error result with the text `no URLs found`.

**`resurrect`** finds the Wayback snapshot of one URL.

- `url` (string, required)
- `date` (string, optional): `YYYY-MM-DD`. The snapshot closest to that date is returned. Without it, the most recent one.
- Returns one of:
  - found: `{ "url", "found": true, "snapshotUrl", "snapshotDate" }`
  - not found: `{ "url", "found": false, "lost": true, "archiveAvailability": "known" }`, meaning the archive answered and holds no copy
  - undecided: `{ "url", "found": false, "lost": false, "archiveAvailability": "unknown" }`, meaning the archive could not be reached, so nothing is claimed
- A missing `url` returns an error result (`url is required`). A `date` in any other format returns `date must be YYYY-MM-DD`.

## Local development

Requires Node 22 or newer.

```sh
npm install
npm run dev     # Vite on http://localhost:5173, proxying /api to wrangler dev on 127.0.0.1:8787
npm test        # Vitest: unit and fast-check property tests
npm run check   # tsc --noEmit
npm run deploy  # builds CLI, MCP and web, then wrangler deploy (needs a Cloudflare login)
```

If port 5173 is taken, Vite picks the next free port and prints it. `npm run dev` stops both
servers on Ctrl+C.

Layout:

```
src/core     pure engine: extract, classify, similarity, patch, guard. No network, no clock.
src/core/lives.ts       picks a URL's longest continuous life and the copy to open
src/net      the only code that touches the network: fetcher, Wayback client, judge-link.ts
             (one judgement per link), github-readme.ts (owner/repo input), scan loop
src/worker   Hono app: POST /api/scan, POST /api/resolve, static assets
src/cli      main.ts (entry) and run.ts (the revenant command)
src/mcp      main.ts (entry) and server.ts (stdio MCP server)
web          Vite app: the graveyard
```

Imports go one way: `worker`, `cli`, `mcp` and `web` use `net`, and `net` uses `core`. Because
`src/core` is pure, its correctness properties are tested with fast-check.

## Limits worth knowing

- `possessed` is only detected when the link redirects to another registrable domain. A hijacked domain that serves new content at the same address is reported `alive`.
- Pages decay before they die, so Revenant opens a copy from up to a year before the last capture; See every capture shows the rest.
- A scan covers at most 200 links. The web app says so when the cap is hit.
- The Worker runs on the Cloudflare free plan, so `POST /api/scan` accepts at most 3 URLs per request. The web app sends batches of 3, two at a time.
- In the Worker, text similarity compares only the first 64 KB of visible text on each side. The CLI and MCP server run on Node and use the same core.
- Response bodies are read up to 512 KB. Outbound requests have an 8 s timeout and follow at most 5 redirects.
- The Worker keeps Wayback answers for 24 h in memory only. It does not use the Cache API, because those calls count toward the free plan's 50 subrequests per request. The memory lives inside one Worker isolate, so a later request can miss the cache and ask the archive again.
- The Wayback Machine can throttle the Worker (HTTP 429) or time out under bursts of requests. A link that needed the archive for comparison is then `restless`, not `dead` or `possessed`. Repeated back-to-back CLI runs can show more `restless` links than a single run.
- For `owner/repo` input, Revenant first tries `raw.githubusercontent.com` on the default branch for `README.md`, `readme.md`, `README`, `Readme.md` and `README.markdown`, which GitHub does not rate-limit. Only if none exists does it call the GitHub API (for READMEs with another name or in `docs/`). The unauthenticated API allows 60 requests per hour per IP, so set `GITHUB_TOKEN` in the CLI environment to raise that; the token is sent to the API only. If GitHub still rate-limits the request, the web app asks you to paste the document.
- Outbound requests are limited to http and https hosts by name. IP literals, `localhost`, `*.local`, `*.internal`, `*.localhost` and URLs with credentials are refused, and the link is `restless` (not checked).

## Built with Kiro

- `.kiro/steering/`: product, tech, structure and UI ("costume") direction
- `.kiro/specs/revenant/`: requirements, design and tasks generated from the brief
- `.kiro/hooks/`: typecheck on save, core and property-test sync, costume and accessibility review
- `.kiro/agents/gravekeeper.md`: read-only reviewer agent
- `.kiro/settings/mcp.json`: registers the Revenant MCP server for Kiro
- `docs/brief/`: requirements, design brief and
  [calibration data](docs/brief/calibration.md) measured on real links
- `docs/design/`: the UI reference mocks

The brief in `docs/brief/` and the UI reference in `docs/design/` were written with another AI
assistant (Claude). Kiro generated the spec (`.kiro/specs/revenant/`) and all application code.

## License

MIT
