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

1. WHEN the input is Markdown, THE SYSTEM SHALL extract inline links (syntax `[text](url)`), reference links (syntax `[text][id]` with a `[id]: url` definition), autolinks (syntax `<url>`), and bare URLs (a token starting with `http://` or `https://` not enclosed in `<>` or `[]()` delimiters). The URL SHALL include balanced parentheses (CommonMark): an inline destination ends at whitespace, at `>`, or at the first `)` that has no matching `(` inside the destination, and the `<url>` form may contain spaces and parentheses; a bare URL loses a trailing `)` only while it has more `)` than `(`, and loses trailing `.,;:!?`. The span of every extracted URL SHALL cover exactly the destination. A `http://` or `https://` with no host (a scheme fragment in prose) SHALL NOT be extracted.
2. WHEN the input is HTML, THE SYSTEM SHALL extract the value of the `href` attribute from every `<a>` element.
3. WHEN the input is a URL starting with `http://` or `https://`, THE SYSTEM SHALL fetch the page at that URL, then extract links from the response body using the rules of criteria 1 and 2 based on the detected content type; IF the fetch fails, the server returns a non-2xx status, or the content type cannot be detected as Markdown or HTML, THEN THE SYSTEM SHALL report an error indicating the URL and the failure reason and perform no extraction.
4. WHEN the input matches the pattern `owner/repo` (two non-empty path segments with no scheme), THE SYSTEM SHALL fetch the default-branch README from that GitHub repository and extract links from its Markdown content using the rules of criterion 1; IF the fetch fails or the repository is not found, THEN THE SYSTEM SHALL report an error indicating the repository and the failure reason and perform no extraction.
5. THE SYSTEM SHALL exclude from extraction any URL that appears inside a fenced code block (delimited by ` ``` ` or `~~~`), and any URL whose scheme is not `http` or `https` (including `mailto:`, fragment-only references starting with `#`, and relative paths without a scheme).
6. WHEN the same URL appears more than once, THE SYSTEM SHALL check that URL exactly once and report all source locations where it appears.
7. IF more than 200 distinct URLs are identified, THEN THE SYSTEM SHALL check only the first 200 URLs in the order they were encountered and include a notice in the output stating that the 200-URL cap was reached and the total number of URLs found.

### Requirement 2: Judge each link

**User Story:** As a writer, I get one trustworthy verdict per link, so I know what to fix.

#### Acceptance Criteria

1. WHEN the live request fails and a DNS-over-HTTPS lookup confirms the host does not exist (NXDOMAIN), or the request returns 404 or 410, THE verdict SHALL be `dead`.
2. WHEN the live request returns 5xx, THE SYSTEM SHALL retry once after 2 seconds; IF the retry also returns 5xx or fails at network level, THE verdict SHALL be `restless` with a reason stating the status code and that it was retried.
3. WHEN the live request returns 401, 403, or 429, THE verdict SHALL be `restless`.
4. WHEN the live request times out after 8 seconds with no response, OR fails with any connection error that is not a confirmed DNS failure (including guard rejections and redirect errors), THE verdict SHALL be `restless` with the error text as reason.
5. WHEN the live request returns 2xx after redirecting to a different registrable domain AND a Snapshot of the original URL exists AND the text similarity score between the live page and that Snapshot is below 0.2, THE verdict SHALL be `possessed`.
6. WHEN the live request returns 2xx after redirecting to a different registrable domain AND no Snapshot of the original URL exists, THE verdict SHALL be `alive` and the reason SHALL name the new registrable domain.
7. WHEN the live request returns 2xx and criterion 5 does not apply, THE verdict SHALL be `alive`.
8. WHEN the final URL shares the same registrable domain as the requested URL, THE verdict SHALL NOT be `possessed`.
9. THE SYSTEM SHALL attach a human-readable reason to every verdict, stating the HTTP status code or connection error, and where applicable the redirect target domain or the similarity score and Snapshot year (for example: `404 Not Found`, `content 7% similar to 2017 capture`, `redirected to example.com`).
10. WHEN the live request returns 2xx after redirecting to a different registrable domain AND the Wayback Machine could not be reached to obtain a Snapshot for comparison, THE verdict SHALL be `restless` and the reason SHALL name the new registrable domain and state that the archive could not be reached.
11. WHEN the live request returns 2xx after redirecting to another registrable domain whose name label (the label to the left of the public suffix) is the same as the requested one, and only the public suffix differs (`exercism.io` to `exercism.org`, `foo.co.uk` to `foo.com`), THE verdict SHALL be `alive` and the reason SHALL be `Moved to {domain}.`, without consulting the Wayback Machine.
12. WHEN the live request returns 2xx after redirecting to the registrable domain that a short documented list of known renames gives for the requested registrable domain (`twitter.com` to `x.com`, also from `mobile.twitter.com`), THE verdict SHALL be `alive` and the reason SHALL be `Moved to {domain}.`, without consulting the Wayback Machine, also when the archive is unreachable.
13. WHEN a Snapshot text exists for comparison AND the live page's visible text has fewer than 200 characters, THE verdict SHALL be `restless` and the reason SHALL be `Redirects to {domain}; the new page has too little text to compare. Not judged.` (200 is under a fifth of the sparsest measured real possessed target, 915 characters). A missing Snapshot keeps criterion 6.

### Requirement 3: Epitaph and resurrection

**User Story:** As a researcher, I see when a source died and get the archived copy, so my citation still works.

#### Acceptance Criteria

1. WHEN a verdict is `dead` or `possessed`, THE SYSTEM SHALL query the Wayback Machine for the checked URL and return the Epitaph of the longest continuous life of the URL in the archive: one Snapshot per month is considered, a gap of more than 12 calendar months starts a new life, the longest life by time span is chosen (the earliest on a tie), the Epitaph first date is that life's first Snapshot and the Epitaph last date is that life's last Snapshot, so the stone shows the whole life. The Epitaph also carries a copy date: pages decay before they die, so the copy is stepped back from the end. With span = calendar months from the life's first to its last Snapshot, margin = min(12, floor(span / 4)) and cutoff = the month of the last Snapshot minus margin, the candidates are the life's Snapshots at or before the cutoff month, and the copy is the last candidate whose body length is at least half the median candidate length (the last candidate when none qualifies or no length is known; a life with one Snapshot is its own copy).
2. IF a Snapshot exists, THEN THE SYSTEM SHALL return the archive URL of the Snapshot chosen as the Epitaph copy date as the Resurrection.
3. IF no Snapshot exists, THEN THE SYSTEM SHALL return the Epitaph with a none status, SHALL indicate the link is lost (never archived), and SHALL NOT return any URL as the Resurrection.
4. IF the Wayback Machine returns a connection error, an HTTP error response, or no response within 10 seconds, THEN THE SYSTEM SHALL retain the existing verdict and return the Epitaph with an unavailable status, SHALL NOT return any URL as the Resurrection, and SHALL indicate that the archive could not be reached and the user can try again. An unavailable status SHALL be distinct from a none status and SHALL NOT be cached for 24 hours.
5. WHEN the archive could not be reached in a way that changed a judgement (an unavailable Epitaph on a dead or possessed link, or a cross-domain 2xx judged restless because the Snapshot was unavailable), THE Judgement SHALL carry `archiveUnavailable: true`. THE flag SHALL NOT be set for restless links caused by the site itself (401, 403, 429, timeout, 5xx, connection errors, guard rejections). THE flag SHALL be set from the structured values, never from reason text, and SHALL appear in the CLI `--json` output and in MCP judgements when set.

6. THE SYSTEM SHALL send every request to the Internet Archive (`web.archive.org` and `archive.org`: the CDX lookup, snapshot bodies, the availability API, and checks of links whose host is the archive, on every redirect hop) through one queue per client or request, with one request in flight at a time and a minimum gap between request starts: 1 s in the CLI and MCP server, 300 ms in the Worker. A `Retry-After` on a 429 or 503 (seconds or HTTP date, capped at 10 s) SHALL delay the next request for every waiting caller. The 10-second limit of criterion 4 SHALL count from the moment a request starts, not from when it was queued. The queue SHALL NOT change the number of requests made for a link.
7. WHEN `scan` has judged every link, THE SYSTEM SHALL ask once more, through the same judgement, about exactly the links whose Judgement carries `archiveUnavailable: true`, and SHALL emit each new answer as a further `judgement` event that replaces the earlier one for the same URL. THE retry SHALL run once; restless links without the flag SHALL NOT be retried. The CLI (`--json`, `--fix`, summary and exit code) and MCP SHALL use the final Judgement per URL.

### Requirement 4: Patch the document

**User Story:** As a maintainer, I download my document with dead links replaced, so the fix takes one click.

#### Acceptance Criteria

1. WHEN the user triggers a patch download, THE SYSTEM SHALL replace the URL of each `dead` or `possessed` Link that has a Resurrection with that Resurrection URL and deliver the result as a downloadable file in the same format as the original document.
2. WHEN the user triggers a patch download, THE SYSTEM SHALL modify only the URL strings within Link target spans and leave all other document content unchanged.
3. `alive` Links, `restless` Links, and `dead` or `possessed` Links that have no Resurrection SHALL NOT be modified by the patch operation.
4. IF the input document has already been patched (such that all previously replaced URLs are Wayback URLs judged `alive`), THEN THE SYSTEM SHALL produce a byte-for-byte identical output to patching it once.
5. WHEN the user deselects a Link before triggering a patch download, THE SYSTEM SHALL treat that Link as excluded and leave its URL unchanged in the patched output.
6. WHEN the user chooses Copy patched document, THE SYSTEM SHALL put on the clipboard exactly the text a download would contain at that moment (one shared builder), SHALL announce `Patched document copied: {n} links changed.` (singular `1 link`) in the live region and show the same text on the button for about 2 s, and IF the Clipboard API is missing or rejects THEN SHALL show the text in a readonly, selected textarea (removed on blur or Escape) and announce how to copy it. Copy SHALL be enabled under the same conditions as Download.

### Requirement 5: Safe fetching

**User Story:** As the operator, the service cannot be used to reach private networks or to hammer a host.

#### Acceptance Criteria

1. THE SYSTEM SHALL reject URLs whose scheme is not `http` or `https`, that contain credentials (userinfo component), or whose host is an IP literal in any form (including dotted-decimal, hex, octal, integer notation, IPv4-mapped IPv6 such as `::ffff:127.0.0.1`, link-local IPv6 `fe80::/10`, and CGNAT range `100.64.0.0/10`), or whose hostname is `localhost`, or ends in `.local`, `.internal`, or `.localhost`.
2. WHEN a redirect response is received, THE SYSTEM SHALL re-validate the redirect target URL against all criteria in criterion 1 before following it, and SHALL reject the request if the total number of redirects for that request exceeds 5.
3. Each request SHALL time out after 8 seconds and read at most 512 KB; IF the response body exceeds 512 KB THE SYSTEM SHALL stop reading after 512 KB and treat the truncated body as the full response.
4. IF the number of in-flight outbound requests for the current scan is already 6, THEN THE SYSTEM SHALL queue the pending request and wait until a slot is free before sending it.

### Requirement 6: Graveyard (web)

**User Story:** As a visitor, I watch my document's links rise as graves and understand the result at a glance.

#### Acceptance Criteria

1. WHEN a scan runs, the browser SHALL send batches of at most 3 URLs at a time to `POST /api/scan`, sending at most 2 batches in flight simultaneously, and SHALL render each returned batch of Judgements as it arrives so results appear progressively with the moon advancing.
2. Each verdict SHALL have a distinct visual element and a text label: a lit window (warm amber) for `alive`, a tombstone for `dead`, a zombie hand with green glow for `possessed`, and a fog patch for `restless`; colour SHALL NOT be the only differentiating signal.
3. A `dead` link's tombstone SHALL display the Epitaph on its face, and tombstone height SHALL scale linearly with the link's lifespan in whole years, with a minimum height (64 px) at 8 or fewer years, or when the link has no dates, and a maximum height (176 px) at 22 or more years. The zombie hand of a `possessed` link SHALL have a fixed height and carry no text; its Epitaph SHALL be shown in the selected link's inscription.
4. WHEN the user activates Resurrect on a grave THEN the Snapshot SHALL open in a new browser tab.
5. IF no Snapshot exists for a `dead` or `possessed` link THEN the Resurrect control SHALL be disabled and display a label indicating no archived version is available.
6. The page SHALL provide all scan results in a table (the ledger) with one row per link, showing at minimum: URL, verdict label, reason, and Resurrection URL where available; and SHALL provide a "download patched document" action that returns the source document with `dead` and `possessed` links replaced by their Resurrection URLs where available.
7. IF `prefers-reduced-motion` is set THEN no animation SHALL play, including rising, drifting, fading, and pulsing effects.
8. Every interactive control SHALL be reachable and operable by keyboard alone, and new results SHALL be announced via a single polite `aria-live` region, batched rather than one announcement per link.
9. The page SHALL offer a single-activation sample document control that loads a pre-supplied document and triggers a scan without requiring the user to provide any input.Answers for a scan that was replaced by a newer one SHALL be discarded.
12. WHEN the page loads with `?sample=1`, `?repo=owner/name` or `?url=https://...`, THE page SHALL scan that source without further input, filling the address field for `repo` and `url`; IF more than one is present, THE page SHALL use the first in the order sample, repo, url and ignore the rest. IF the `repo` value is not `owner/name`, or the `url` value is not http or https, has credentials or fails the guard, THEN THE page SHALL show the existing error under the field and SHALL NOT scan.
13. WHEN a scan started from the address field (typed, from `repo`/`url`, or resolved), or from "Scan the sample", THE page SHALL update the query string with `history.replaceState` (no history entry) to `?repo=owner/name`, `?url=<encoded>` or `?sample=1`, remove the other scan parameters and keep unrelated ones. A scan from the textarea SHALL remove `repo`, `url` and `sample` and SHALL NOT write any part of the document into the URL.
14. WHILE the result of a scan has an address (sample, repo or url), THE page SHALL show a "Copy link" button near the status heading that copies `location.href`, falling back to selecting a readonly field when the clipboard API is missing or rejects. It SHALL announce "Link copied." once in the polite live region and show the same text on the button for about 2 s.

10. THE inscription of a restless link, and of a dead or possessed link with `archiveUnavailable`, SHALL offer an "Ask again" button (plain .btn style). WHEN activated, the page SHALL re-judge that one link through POST /api/scan with that URL alone, disable the button and label it "Asking..." while it runs, and on the answer replace that judgement in place: plot shape, label and stone height, ledger row (the Patch checkbox is checked by default when the link now has a Snapshot and keeps the user's choice when it had one), tally, patch note, Download state and the inscription if still selected. Document order, selection and keyboard focus SHALL be kept, the replaced plot rises like a new plot (no rise under reduced motion), and the new verdict SHALL be announced in one live message. IF the request fails, THEN the page SHALL show the existing error message and keep the old judgement.
11. WHEN a scan ends, THE page SHALL ask once, automatically, about every link with `archiveUnavailable`, in batches of at most 3 with at most 2 in flight and no reveal wait. Restless links without the flag SHALL NOT be retried automatically, and there SHALL be no second automatic round. The final status line and the bell SHALL come after the retry; one live message SHALL announce it. Answers for a scan that was replaced by a newer one SHALL be discarded.
15. BEFORE a scan has results, THE hero SHALL show the heading "Bring your dead links back.", the text "Give Revenant a GitHub repo, a page or a pasted document. It finds the links that died or now lead somewhere else, and returns the document with each one pointing to its archived copy.", a labelled address field ("GitHub repo or page address", placeholder "owner/repo or https://...") with the primary button "Scan its links", a "Try:" row with three links (`/?repo=mtdvio/every-programmer-should-know`, `/?repo=donnemartin/system-design-primer`, `/?repo=danistefanovic/build-your-own-x`, shown as owner/repo, full navigation) and the secondary button "Scan the sample". Enter in the field SHALL submit the address scan. The textarea below the yard SHALL be labelled "Or paste a document" and its button "Scan the document" SHALL be secondary, so each region has one primary action. A scan from the textarea SHALL clear the address field. The page SHALL contain exactly one address field. An empty or invalid address SHALL show its error under the hero field, with `aria-invalid` and `aria-describedby` set on that field only while the error is shown.
16. WHILE a scan runs, THE hero SHALL hide the address form, the "Try:" row and the explanation, and the heading SHALL show the progress text ("Judging N links."). WHEN the scan has results, THE hero SHALL keep the address form, below the tally, and hide the explanation and the "Try:" row, so another address can always be scanned. IF a scan ends with no results, THEN THE hero SHALL show all of its input again.
17. WHEN a scan ends, THE heading SHALL state the result: with `gone` = dead + possessed, `fixable` = those with a Snapshot, `total` links and `n` restless links, "{gone} of {total} links are gone. {fixable} can come back." (or "None can come back."), or "All {total} links still lead where they should." when `gone` is 0, followed by "{n} could not be judged." when `n` > 0, with singular forms ("1 of 9 links is gone.", "1 of 1 link is gone.", "1 can come back.", "All 1 link still leads where it should."). IF some batches failed, THEN THE heading SHALL begin "{judged} of {total} links judged." and state the verdict sentence for the judged links only when `judged` > 0. THE heading SHALL update when a judgement is replaced (Ask again, automatic retry), and the live region SHALL announce the final heading once, at the end.
18. WHEN a scan came from `owner/repo` and `/api/resolve` returned the README's file name, THE ledger header SHALL show a link `Open {file} on GitHub` that opens in a new tab with `rel="noopener"`, built from a validated `owner/repo` and a relative path without `..` whose segments are each URL-encoded, so that no file name can change the host or the scheme. The link SHALL point to `https://github.com/{owner}/{repo}/blob/HEAD/{file}`: anonymous requests to `/edit/HEAD/...`, `/edit/main/...` and `/edit/no-such-branch-xyz/...` all answer 302 to the login page, so `HEAD` could not be shown to work in an edit URL (`GITHUB_FILE_MODE` in `web/github-file.ts` switches it to `edit` once checked while logged in).
19. THE ledger header SHALL list the steps to the fix as an ordered list next to the buttons: "Copy the patched document.", "Open the README on GitHub.", "Paste it and propose the change." when the GitHub link is shown, otherwise "Copy or download the patched document.", "Replace the original with it."

### Requirement 7: CLI

**User Story:** As a maintainer, I run the check in CI so rot is caught on every push.

#### Acceptance Criteria

1. WHEN `revenant <file|url>` is invoked, THE SYSTEM SHALL print one line per non-alive Link to stdout, where each line contains the original URL, verdict (`dead`, `possessed`, or `restless`), reason, and Resurrection URL (or a placeholder indicating none when no Resurrection exists).
2. THE SYSTEM SHALL exit with code 1 if any checked Link has verdict `dead` or `possessed`, and exit with code 0 if all Links are `alive` or `restless`.
3. WHEN `revenant <file|url>` is invoked with no flags and all Links are `alive`, THE SYSTEM SHALL print no output and exit with code 0.
4. WHEN `--fix` is provided, THE SYSTEM SHALL overwrite the input file in place, replacing each `dead` or `possessed` Link's URL with its Resurrection URL, leaving Links with no Resurrection unchanged.
5. IF `--fix` is provided and the input is a URL rather than a file path, THEN THE SYSTEM SHALL report an error indicating that `--fix` requires a file path, emit that error as a JSON structure when `--json` is also set, and exit with code 2.
6. WHEN `--json` is provided, THE SYSTEM SHALL print a single JSON structure to stdout containing every checked Link with its URL, verdict, reason, and Resurrection URL, and SHALL NOT print the plain-text per-line format.

### Requirement 8: MCP server

**User Story:** As an AI agent, I verify URLs before I cite them.

#### Acceptance Criteria

1. WHEN `check_links` is called with a text string containing no URLs or with an empty URL list, THE server SHALL return an error response indicating that no URLs were found, rather than an empty Judgement list.
2. WHEN `check_links` is called with a text string or a list of up to 200 URLs, THE server SHALL return one Judgement per distinct URL containing the verdict, reason, and Resurrection where available, and SHALL apply the same 200-URL cap and safe-fetching rules defined in Requirements 1.7 and 5.
3. WHEN `resurrect` is called with a URL and an optional date, THE server SHALL return the Snapshot URL whose capture date is closest to the given date, or the most recent Snapshot if no date is provided; IF no Snapshot exists AND the Wayback Machine is unreachable, THE server SHALL return both an indication that the link is lost and an indication that archive availability is unknown; IF only no Snapshot exists, THE server SHALL return an indication that the link is lost and SHALL NOT return an invented URL; IF only the Wayback Machine is unreachable, THE server SHALL return an indication that archive availability is unknown.
4. WHERE the server shares the same core functions and safe-fetching rules as the web application, THE server SHALL produce a `restless` verdict with the rejection reason for any URL rejected by Requirement 5.1, identical to the verdict the web application would produce.
