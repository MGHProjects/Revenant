---
inclusion: fileMatch
fileMatchPattern: "web/**/*"
---

# The costume (UI direction)

The screen is a **night graveyard seen from the gate**. The document being scanned is the ground;
its links rise out of it one by one as the scan streams in.

## Every element means something

- **Lit window** (warm amber) = `alive`. **Tombstone** = `dead`. **Zombie hand with green glow** =
  `possessed`. **Fog patch** = `restless`.
- Tombstone **height** = how long the link lived (the longest continuous life in the archive).
  The **epitaph** carved on it is real data: `2009 – 2017 · last seen alive 14 Mar 2017`.
- The **moon** is the progress indicator: it waxes from new to full as the scan completes.
- **Resurrect** raises a pale ghost from the grave that becomes the link to the snapshot.
- A plain **ledger** (accessible table) sits below the scene with the same data. The scene is
  never the only way to read a result.

## Look

- Palette: ink `#0b0d12`, slate `#1c2230`, bone `#e8e2d0`, amber `#f2a541`, ectoplasm `#7dffb0`,
  blood `#c8323c` (errors only). Text is bone on ink; check contrast ≥ 4.5:1.
- Type: one carved display face for headings and epitaphs, system sans for everything else.
- Motion is slow and heavy (400–900 ms, ease-out). Things rise; nothing bounces or spins.
- No stock Halloween clip art, no emoji as icons, no purple gradients, no glassmorphism.

## Accessibility (cannot be cut)

- Status is never colour-only: each verdict has its shape and a text label.
- `prefers-reduced-motion`: no rising, no fog drift; results simply appear.
- Full keyboard path: paste → scan → move through graves with arrows → Enter opens the snapshot.
- New results are announced through one polite `aria-live` region, batched, not one per link.
- Sound is off by default and has a visible toggle.
