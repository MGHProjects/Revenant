# Requirements Document

## Introduction

Revenant is a link-rot checker and document patcher. It scans Markdown, HTML, or remote documents, assigns a trustworthy verdict to every absolute HTTP/HTTPS link it finds, retrieves archived copies of dead or hijacked links from the Wayback Machine, and produces a patched document with broken links replaced. Revenant is exposed through three surfaces: a streaming web UI (the Graveyard), a CLI for CI pipelines, and an MCP server for AI agent use.

## Glossary

- **Link**: an absolute http/https URL found in the input, with its byte span in the source.
- **Verdict**: one of `alive`, `dead`, `possessed`, `restless`.
- **Snapshot**: a Wayback Machine capture with status 200.
- **Epitaph**: first and last Snapshot dates of a Link.
- **Resurrection**: the Snapshot URL proposed as replacement.

## Requirements

### Requirement 1: Extract links

**User Story:** As a maintainer, I paste a document and every link in it is found, so nothing is missed.

#### Acceptance Criteria

1. WHEN the input is Markdown, THE SYSTEM SHALL extract inline links (syntax `[text](url)`), reference links (syntax `[text][id]` with a `[id]: url` definition), autolinks (syntax `<url>`), and bare URLs (a token starting with `http://` or `https://` not enclosed in `<>` or `[]()` delimiters).
2. WHEN the input is HTML, THE SYSTEM SHALL extract the value of the `href` attribute from every `<a>` element.
3. WHEN the input is a URL starting with `http://` or `https://`, THE SYSTEM SHALL fetch the page at that URL, then extract links from the response body using the rules of criteria 1 and 2 based on the detected content type; IF the fetch fails, the server returns a non-2xx status, or the content type cannot be detected as Markdown or HTML, THEN THE SYSTEM SHALL report an error indicating the URL and the failure reason and perform no extraction.
4. WHEN the input matches the pattern `owner/repo` (two non-empty path segments with no scheme), THE SYSTEM SHALL fetch the default-branch README from that GitHub repository and extract links from its Markdown content using the rules of criterion 1; IF the fetch fails or the repository is not found, THEN THE SYSTEM SHALL report an error indicating the repository and the failure reason and perform no extraction.
5. THE SYSTEM SHALL exclude from extraction any URL that appears inside a fenced code block (delimited by ` ``` ` or `~~~`), and any URL whose scheme is not `http` or `https` (including `mailto:`, fragment-only references starting with `#`, and relative paths without a scheme).
6. WHEN the same URL appears more than once, THE SYSTEM SHALL check that URL exactly once and report all source locations where it appears.
7. IF more than 200 distinct URLs are identified, THEN THE SYSTEM SHALL check only the first 200 URLs in the order they were encountered and include a notice in the output stating that the 200-URL cap was reached and the total number of URLs found.

### Requirement 2: Judge each link

**User Story:** As a writer, I get one trustworthy verdict per link, so I know what to fix.

#### Acceptance Criteria

1. WHEN the live request fails at DNS/connection, or returns 404 or 410, THE verdict SHALL be `dead`.
2. WHEN the live request returns 5xx, THE SYSTEM SHALL retry once after 2 seconds, and IF the retry also returns 5xx or fails, THEN THE verdict SHALL be `dead`.
3. WHEN the live request returns 401, 403, or 429, THE verdict SHALL be `restless`.
4. WHEN the live request times out after 8 seconds with no response, THE verdict SHALL be `restless`.
5. WHEN the live request returns 2xx after redirecting to a different registrable domain AND a Snapshot of the original URL exists AND the text similarity score between the live page and that Snapshot is below 0.2, THE verdict SHALL be `possessed`.
6. WHEN the live request returns 2xx after redirecting to a different registrable domain AND no Snapshot of the original URL exists, THE verdict SHALL be `alive` and the reason SHALL name the new registrable domain.
7. WHEN the live request returns 2xx and criterion 5 does not apply, THE verdict SHALL be `alive`.
8. WHEN the final URL shares the same registrable domain as the requested URL, THE verdict SHALL NOT be `possessed`.
9. THE SYSTEM SHALL attach a human-readable reason to every verdict, stating the HTTP status code or connection error, and where applicable the redirect target domain or the similarity score and Snapshot year (for example: `404 Not Found`, `content 7% similar to 2017 capture`, `redirected to example.com`).

### Requirement 3: Epitaph and resurrection

**User Story:** As a researcher, I see when a source died and get the archived copy, so my citation still works.

#### Acceptance Criteria

1. WHEN a verdict is `dead` or `possessed`, THE SYSTEM SHALL query the Wayback Machine for the checked URL and return the earliest available Snapshot by archive timestamp and the most recent available Snapshot by archive timestamp as the Epitaph.
2. IF a Snapshot exists, THEN THE SYSTEM SHALL return its archive URL as the Resurrection.
3. IF no Snapshot exists, THEN THE SYSTEM SHALL indicate the link is lost and SHALL NOT return any URL as the Resurrection.
4. IF the Wayback Machine returns a connection error, an HTTP error response, or no response within 10 seconds, THEN THE SYSTEM SHALL retain the existing verdict and return the Epitaph with an unavailable status.

### Requirement 4: Patch the document

**User Story:** As a maintainer, I download my document with dead links replaced, so the fix takes one click.

#### Acceptance Criteria

1. WHEN the user triggers a patch download, THE SYSTEM SHALL replace the URL of each `dead` Link that has a Resurrection with that Resurrection URL and deliver the result as a downloadable file in the same format as the original document.
2. WHEN the user triggers a patch download, THE SYSTEM SHALL modify only the URL strings within Link target spans and leave all other document content unchanged.
3. `alive` Links, `restless` Links, and `dead` Links that have no Resurrection SHALL NOT be modified by the patch operation.
4. IF the input document has already been patched, THEN THE SYSTEM SHALL re-evaluate each link's status fresh at patch time and produce a byte-for-byte identical output to patching it once, based on the current live and archive state.
5. WHEN the user deselects a Link before triggering a patch download, THE SYSTEM SHALL treat that Link as excluded and leave its URL unchanged in the patched output.

### Requirement 5: Safe fetching

**User Story:** As the operator, the service cannot be used to reach private networks or to hammer a host.

#### Acceptance Criteria

1. THE SYSTEM SHALL reject URLs whose scheme is not `http` or `https`, that contain credentials (userinfo component), or whose resolved host is an IP literal in the ranges 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, ::1, or fc00::/7, or whose hostname is `localhost`, or ends in `.local`, `.internal`, or `.localhost`.
2. WHEN a redirect response is received, THE SYSTEM SHALL re-validate the redirect target URL against all criteria in criterion 1 before following it, and SHALL reject the request if the total number of redirects for that request exceeds 5.
3. WHEN an outbound request is initiated, THE SYSTEM SHALL independently report a timeout error if no complete response is received within 8 seconds, AND SHALL independently discard the response body and report a body-size error if the response body exceeds 512 KB; both errors SHALL be reported when both conditions hold simultaneously.
4. IF the number of in-flight outbound requests for the current scan is already 6, THEN THE SYSTEM SHALL queue the pending request and wait until a slot is free before sending it.

### Requirement 6: Graveyard (web)

**User Story:** As a visitor, I watch my document's links rise as graves and understand the result at a glance.

#### Acceptance Criteria

1. WHEN a scan runs THEN results SHALL stream to the page and appear one by one in arrival order, with the moon icon advancing one step per result to reflect overall progress.
2. Each verdict SHALL render with a distinct shape per status — a crumbling tombstone for `dead`, an upright tombstone for `alive`, and a leaning tombstone for `possessed` or `restless` — and each shape SHALL carry a visible text label matching the status name; colour SHALL NOT be the only differentiating signal.
3. A `dead` link's tombstone SHALL display the Epitaph (first and last Snapshot dates), and the tombstone height SHALL scale linearly with the link's lifespan in whole years, with a minimum height at 0 years and a maximum height at 30 or more years.
4. WHEN the user activates Resurrect on a grave THEN the Snapshot SHALL open in a new browser tab.
5. IF no Snapshot exists for a `dead` link THEN the Resurrect control SHALL be disabled and display a label indicating no archived version is available.
6. The page SHALL provide all scan results in a table (the ledger) with one row per link, showing at minimum: URL, verdict label, reason, and Resurrection URL where available; and SHALL provide a "download patched document" action that returns the source document with dead links replaced by their Resurrection URLs where available.
7. IF `prefers-reduced-motion` is set THEN no animation SHALL play, including rising, drifting, fading, and pulsing effects.
8. Every interactive control SHALL be reachable and operable by keyboard alone, and each new result appended during a scan SHALL be announced via an ARIA live region with politeness set to `polite`.
9. The page SHALL offer a single-activation sample document control that loads a pre-supplied document and triggers a scan without requiring the user to provide any input.

### Requirement 7: CLI

**User Story:** As a maintainer, I run the check in CI so rot is caught on every push.

#### Acceptance Criteria

1. WHEN `revenant <file|url>` is invoked, THE SYSTEM SHALL print one line per non-alive Link to stdout, where each line contains the original URL, verdict (`dead`, `possessed`, or `restless`), reason, and Resurrection URL (or a placeholder indicating none when no Resurrection exists).
2. THE SYSTEM SHALL exit with code 1 if any checked Link has verdict `dead` or `possessed`, and exit with code 0 if all Links are `alive` or `restless`.
3. WHEN `revenant <file|url>` is invoked with no flags and all Links are `alive`, THE SYSTEM SHALL print no output and exit with code 0.
4. WHEN `--fix` is provided, THE SYSTEM SHALL overwrite the input file in place, replacing each dead Link's URL with its Resurrection URL, leaving Links with no Resurrection unchanged.
5. IF `--fix` is provided and the input is a URL rather than a file path, THEN THE SYSTEM SHALL report an error indicating that `--fix` requires a file path, emit that error as a JSON structure when `--json` is also set, and exit with code 2.
6. WHEN `--json` is provided, THE SYSTEM SHALL print a single JSON structure to stdout containing every checked Link with its URL, verdict, reason, and Resurrection URL, and SHALL NOT print the plain-text per-line format.

### Requirement 8: MCP server

**User Story:** As an AI agent, I verify URLs before I cite them.

#### Acceptance Criteria

1. WHEN `check_links` is called with a text string containing no URLs or with an empty URL list, THE server SHALL return an error response indicating that no URLs were found, rather than an empty Judgement list.
2. WHEN `check_links` is called with a text string or a list of up to 200 URLs, THE server SHALL return one Judgement per distinct URL containing the verdict, reason, and Resurrection where available, and SHALL apply the same 200-URL cap and safe-fetching rules defined in Requirements 1.7 and 5.
3. WHEN `resurrect` is called with a URL and an optional date, THE server SHALL return the Snapshot URL whose capture date is closest to the given date, or the most recent Snapshot if no date is provided; IF no Snapshot exists AND the Wayback Machine is unreachable, THE server SHALL return both an indication that the link is lost and an indication that archive availability is unknown; IF only no Snapshot exists, THE server SHALL return an indication that the link is lost and SHALL NOT return an invented URL; IF only the Wayback Machine is unreachable, THE server SHALL return an indication that archive availability is unknown.
4. WHERE the server shares the same core functions and safe-fetching rules as the web application, THE server SHALL produce a `restless` verdict with the rejection reason for any URL rejected by Requirement 5.1, identical to the verdict the web application would produce.
