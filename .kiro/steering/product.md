---
inclusion: always
---

# Revenant — product

**One line:** Revenant finds the dead and *possessed* links in any document and brings them back from the Internet Archive.

## Problem

Links rot. Pew Research (2024) found 38% of web pages from 2013 are gone, and 54% of Wikipedia
pages have at least one dead reference. Worse than a dead link is a *possessed* one: the URL still
answers 200, but the domain was sold and now serves ads, spam or malware. Ordinary link checkers
call that link "OK".

## Audience

1. Open-source maintainers (READMEs, docs sites).
2. Writers, researchers and journalists whose citations must stay verifiable.
3. AI agents that cite URLs and need to verify them first (via the MCP server).

## What it does

Paste Markdown/HTML, a page URL, or `owner/repo`. Every link gets one verdict:

| Verdict | Costume | Meaning |
|---|---|---|
| `alive` | lit window | Responds, content still matches its archived self |
| `dead` | tombstone | Gone (DNS failure, 404/410, persistent 5xx) |
| `possessed` | green-eyed zombie | Responds, but now redirects to another domain whose content is nothing like the archived page |
| `restless` | fog | Cannot tell (401/403/429/timeout). Never reported as dead |

Dead and possessed links get an **epitaph** (first and last good capture dates from the Wayback
Machine) and a **resurrection**: the closest good snapshot URL. The user downloads the patched
document, or runs the same engine as a CLI in CI, or as an MCP tool inside an agent.

## Principles

- **Never cry wolf.** A false "dead" costs trust. When unsure, the verdict is `restless`.
- **The costume is the interface.** Every spooky element on the ground encodes state; the static horizon is the only scenery.
- **One engine, three doors.** Web, CLI and MCP call the same pure core. No logic lives in a door.
- Hackathon category: **Costume Contest** (Kiroween 2026).
