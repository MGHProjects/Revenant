# Revenant

**Find the dead and possessed links in any document, and bring them back from the Internet Archive.**

Built for [Kiroween 2026](https://kiroween.devpost.com/) — category: Costume Contest.

38% of web pages from 2013 no longer exist. Some are worse than dead: the URL still answers, but
the domain was sold and now serves something else. Revenant gives every link one verdict —
`alive`, `dead`, `possessed` or `restless` — shows when it died, and replaces it with its closest
archived snapshot.

- **Web:** paste a document, watch its links rise as a graveyard, download the patched file.
- **CLI:** `npx revenant README.md --fix` — exits 1 on rot, for CI.
- **MCP:** `check_links` and `resurrect` tools so AI agents verify URLs before citing them.

## Status

Not implemented yet. This repository currently holds the product brief and the Kiro setup:

- `.kiro/steering/` — product, tech, structure and UI ("costume") direction
- `.kiro/hooks/` — typecheck on save, core/property-test sync, costume and accessibility review
- `.kiro/agents/gravekeeper.md` — read-only reviewer agent
- `docs/brief/` — human-written requirements and design brief, plus
  [calibration data](docs/brief/calibration.md) measured on real links
- `samples/haunted-readme.md` — sample document with one verified link per verdict

The spec in `.kiro/specs/revenant/` and the application code are generated with Kiro from the brief.

## License

MIT
