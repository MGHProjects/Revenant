# Devpost submission — draft

Everything marked `[FILL]` must come from what actually happened (see `docs/build-log.md`).
Do not submit a `[FILL]`.

**Category:** Costume Contest
**Tagline:** Your links are dying. Some are worse than dead. Revenant brings them back.

## Description

38% of web pages that existed in 2013 are gone, and more than half of Wikipedia articles carry at
least one dead reference. Every README, paper and blog post is quietly rotting.

Link checkers only catch half of it. When a domain expires and is bought by someone else, the old
link still answers `200 OK` — and now leads to a shop, an ad page, or worse. We call those links
**possessed**. In our test set, `kiko.com` (the calendar startup famously sold on eBay) now lands
on an unrelated store, and every ordinary checker reports it healthy.

**Revenant** reads any document — pasted Markdown or HTML, a page URL, or a GitHub repo — and
gives every link one verdict:

- **Alive** — a lit window.
- **Dead** — a tombstone, carved with its real dates from the Internet Archive.
- **Possessed** — a hand out of the ground: it answers, but it is no longer the page you cited.
- **Restless** — fog: the site blocks robots, so we refuse to guess. npm returns 403 to scripts;
  other tools call that broken. Revenant never cries wolf.

One click replaces every dead and possessed link with its closest archived snapshot and hands
back the patched document.

The same engine has three doors: the web graveyard, a CLI that fails your CI build when links
rot, and an MCP server so AI agents can verify a URL before they cite it.

## Why the costume is the interface

Nothing on screen is decoration. A grave's height is how long the link lived. The epitaph is its
first and last capture. The moon is the progress bar. A plain table below carries the same data
for screen readers, the whole flow works from the keyboard, and reduced-motion is honoured.

## What we learned from real data

Our first rule for "possessed" was "the page no longer resembles its last archived copy". We
measured it on real links before building and it failed both ways: replaced sites score 1.00
(the Archive has already captured the impostor) and Hacker News scores 0.13 (it just changes
hourly). The rule that survived the data is a redirect to another domain plus near-zero
similarity. The full table is in `docs/brief/calibration.md`.

## How Kiro was used

- **Steering:** [FILL — which of the four files changed Kiro's output most, with one before/after example]
- **Spec-driven development:** [FILL — how the human-written brief became Kiro's spec; what Analyze Requirements caught]
- **Property-based testing:** [FILL — the counterexample(s) fast-check found, which property, what the bug was]
- **Hooks:** [FILL — which hook fired most; one thing it caught]
- **Custom agent (gravekeeper):** [FILL — a task it rejected and why]
- **MCP:** [FILL — using Revenant's own MCP server from Kiro on this repo]
- **Spec vs vibe:** [FILL — structure by spec, SVG scene by vibe; which was better for what]
- **IDE vs CLI:** [FILL]
- **Disclosure:** the product brief, steering drafts and calibration data in `docs/brief/` were
  written before the first Kiro session with help from another AI assistant. Kiro generated the
  spec in `.kiro/specs/` from them and wrote the application code.

## Video script (2:45)

| Time | Picture | Voice |
|---|---|---|
| 0:00–0:15 | A README. Cursor clicks a link: 404. Clicks another: a spam shop. | "Everything you ever linked to is dying. And some of it is worse than dead." |
| 0:15–0:30 | Title card: Revenant. | "Revenant finds the dead and the possessed links in any document, and brings them back." |
| 0:30–1:15 | Paste the sample. Moon waxes, graves rise one by one. Hover a tombstone: epitaph. | Name the four verdicts as each appears. Read one epitaph aloud. |
| 1:15–1:35 | The possessed grave: kiko.com → a shop. Then the fog: npm, 403. | "Other checkers say this one is fine, and this one is broken. Both wrong." |
| 1:35–1:55 | Click Resurrect: the archived page opens. Download patched file, show the diff. | "One click, and the citation works again." |
| 1:55–2:10 | Terminal: CLI exits 1 in CI. Kiro chat calling `check_links` via MCP. | "Same engine in your pipeline, and inside your agent." |
| 2:10–2:35 | Kiro: spec with linked properties, a failing property test and its counterexample, gravekeeper rejecting a task. | [FILL — the real story of one bug Kiro's property test caught] |
| 2:35–2:45 | Graveyard at full moon, URL on screen. | "Revenant. Nothing you cite should stay dead." |

No copyrighted music. Record at the real deployed URL. Public on YouTube.

## Checklist before submitting

- [ ] Public GitHub repo, MIT licence shown in About
- [ ] `.kiro/` at the root, not in `.gitignore`, containing steering, specs, hooks, agents
- [ ] Live URL works without login; sample button shows all four verdicts
- [ ] README has run instructions that work from a clean clone
- [ ] Video under 3:00, public
- [ ] No `[FILL]` left in the text
- [ ] Blog URL and social post URL (starts with `#KiroweenHackathon26`) if entering those prizes
