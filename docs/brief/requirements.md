# Requirements brief — Revenant

Input for Kiro spec mode (Requirements-First). Kiro generates the real spec in `.kiro/specs/revenant/` from this.

## Glossary

- **Link**: an absolute http/https URL found in the input, with its byte span in the source.
- **Verdict**: one of `alive`, `dead`, `possessed`, `restless`.
- **Snapshot**: a Wayback Machine capture with status 200.
- **Epitaph**: first and last Snapshot dates of a Link.
- **Resurrection**: the Snapshot URL proposed as replacement.

## 1. Extract links

**User story:** As a maintainer, I paste a document and every link in it is found, so nothing is missed.

1. WHEN the input is Markdown THE SYSTEM SHALL extract inline links, reference links, autolinks and bare URLs.
2. WHEN the input is HTML THE SYSTEM SHALL extract `href` values of `<a>` elements.
3. WHEN the input is a page URL or `owner/repo` THE SYSTEM SHALL fetch that page (or the repo README) and extract from its content.
4. THE SYSTEM SHALL ignore links inside fenced code blocks, and non-http schemes (`mailto:`, `#anchor`, relative paths).
5. WHEN the same URL appears several times THE SYSTEM SHALL check it once and report every span.
6. IF more than 200 distinct URLs are found THE SYSTEM SHALL check the first 200 and state that the cap was reached.

## 2. Judge each link

**User story:** As a writer, I get one trustworthy verdict per link, so I know what to fix.

1. WHEN the live request fails at DNS/connection, or returns 404 or 410, THE verdict SHALL be `dead`.
2. WHEN the live request returns 5xx THE SYSTEM SHALL retry once after 2 s, and only then the verdict SHALL be `dead`.
3. WHEN the live request returns 401, 403, 429 or times out THE verdict SHALL be `restless`.
4. WHEN the live request returns 2xx after redirecting to a different registrable domain AND a Snapshot of the original URL exists AND text similarity between the live page and that last Snapshot is below 0.2 THE verdict SHALL be `possessed`.
5. WHEN the live request returns 2xx after redirecting to a different registrable domain AND no Snapshot exists THE verdict SHALL be `alive` and the reason SHALL name the new host.
6. WHEN the live request returns 2xx and 4 does not apply THE verdict SHALL be `alive`.
7. Every verdict SHALL carry a human-readable reason (for example `404 Not Found`, `content 7% similar to 2017 capture`).
8. WHEN the final URL has the same registrable domain as the requested URL THE verdict SHALL NOT be `possessed`. (See `calibration.md`: same-host similarity cannot separate hijacks from normal change.)

## 3. Epitaph and resurrection

**User story:** As a researcher, I see when a source died and get the archived copy, so my citation still works.

1. WHEN a verdict is `dead` or `possessed` THE SYSTEM SHALL look up the first and last Snapshot and return them as the Epitaph.
2. WHEN a Snapshot exists THE SYSTEM SHALL return its URL as the Resurrection.
3. IF no Snapshot exists THE SYSTEM SHALL say the link is lost, and SHALL NOT invent a URL.
4. IF the Wayback Machine is unreachable THE SYSTEM SHALL keep the verdict and mark the Epitaph as unavailable.

## 4. Patch the document

**User story:** As a maintainer, I download my document with dead links replaced, so the fix takes one click.

1. WHEN the user asks to patch THE SYSTEM SHALL replace each resurrectable Link target with its Resurrection.
2. The patch SHALL change only bytes inside Link target spans.
3. `alive` and `restless` Links SHALL NOT be changed.
4. Patching an already patched document SHALL produce the same document.
5. The user SHALL be able to exclude individual Links from the patch before downloading.

## 5. Safe fetching

**User story:** As the operator, the service cannot be used to reach private networks or to hammer a host.

1. THE SYSTEM SHALL reject URLs whose scheme is not http/https, that contain credentials, or whose host is an IP literal, `localhost`, or ends in `.local`, `.internal`, `.localhost`.
2. THE SYSTEM SHALL re-validate every redirect hop and follow at most 5.
3. Each request SHALL time out after 8 s and read at most 512 KB.
4. THE SYSTEM SHALL run at most 6 outbound requests at once per scan.

## 6. Graveyard (web)

**User story:** As a visitor, I watch my document's links rise as graves and understand the result at a glance.

1. WHEN a scan runs THEN results SHALL stream to the page and appear one by one, with the moon showing progress.
2. Each verdict SHALL have a distinct shape and a text label; colour SHALL NOT be the only signal.
3. A `dead` Link SHALL show its Epitaph on the tombstone, and tombstone height SHALL scale with lifespan.
4. WHEN the user activates Resurrect on a grave THEN the Snapshot SHALL open in a new tab.
5. The page SHALL provide the same results as a table (the ledger) and a "download patched document" action.
6. WHEN `prefers-reduced-motion` is set THEN no rising or drifting animation SHALL play.
7. Every action SHALL be reachable by keyboard, and new results SHALL be announced via a polite live region.
8. The page SHALL offer a one-click sample document so a judge can try it without typing.

## 7. CLI

**User story:** As a maintainer, I run the check in CI so rot is caught on every push.

1. `revenant <file|url>` SHALL print one line per non-alive Link with verdict, reason and Resurrection.
2. The exit code SHALL be 1 if any Link is `dead` or `possessed`, else 0. `restless` SHALL NOT fail the run.
3. `--fix` SHALL write the patched file in place. `--json` SHALL print the raw result.

## 8. MCP server

**User story:** As an AI agent, I verify URLs before I cite them.

1. The server SHALL expose `check_links(text | urls[])` returning verdicts, reasons and Resurrections.
2. The server SHALL expose `resurrect(url, date?)` returning the Snapshot closest to the date.
3. Both tools SHALL use the same core and the same safe-fetching rules as the web app.
