# Calibration — what real links look like

Measured on 16 Nov 2026 from a home connection with a throwaway script (not part of the product).
Similarity = Jaccard index over 3-word shingles of visible text, live page vs a Wayback capture.
Re-run from the deployed Worker before the demo: verdicts can differ by network.

## Data

| URL | Live result | vs first | vs middle | vs last | Truth |
|---|---|---|---|---|---|
| paulgraham.com/hp.html | 200 | 0.99 | 1.00 | 1.00 | alive, stable |
| w3.org/Provider/Style/URI | 200 | 0.93 | 0.01 | 1.00 | alive, stable (one odd capture) |
| rfc-editor.org/rfc/rfc2616 | 200, same-domain redirect | 0.62 | 0.62 | 0.62 | alive |
| gnu.org/philosophy/free-sw.html | 200 | 0.04 | 0.51 | 1.00 | alive, edited over 28 years |
| en.wikipedia.org/wiki/Link_rot | 200 | 0.01 | 0.16 | 0.97 | alive, heavily edited |
| news.ycombinator.com | 200 | 0.01 | 0.03 | **0.13** | alive, changes hourly |
| info.cern.ch/…/TheProject.html | 200 | 0.01 | 0.00 | 1.00 | alive |
| friendster.com | 200, same host | 0.01 | 0.00 | **1.00** | replaced by a different site |
| picnik.com | 200, same host | 0.00 | n/a | **1.00** | replaced |
| stumbleupon.com | 200, same host | 0.00 | 0.00 | **1.00** | replaced |
| kiko.com | 200 → bestshop.com | 0.00 | 0.01 | 0.00 | **possessed** |
| geocities.com/SiliconValley/ | 200 → yahoo.com | 0.00 | 0.00 | 0.00 | **possessed** |
| codeplex.com | 200 → microsoft.com | 0.00 | 0.00 | 0.00 | **possessed** |
| plus.google.com | 200 → googleblog.com | 0.00 | 0.00 | 0.00 | **possessed** |
| altavista.com | 200 → search.yahoo.com | 0.00 | 0.01 | 0.04 | **possessed** |
| dmoz.org, xmarks.com | DNS failure | | | | dead |
| freebase.com, posterous.com, gowalla.com, google.com/reader/about/ | 404 | | | | dead |
| npmjs.com/package/left-pad, researchgate.net/publication/… | 403 | | | | alive, blocks bots → `restless` |

## What this changes

1. **"Low similarity to the last capture" is the wrong test on its own.** It misses replaced sites
   (the Archive has already captured the replacement, so similarity is 1.00) and it falsely
   accuses fast-changing pages (Hacker News scores 0.13).
2. **Old captures do not rescue it.** Honest pages drift to ~0 against their first capture
   (GNU 0.04, Wikipedia 0.01), exactly like replaced ones.
3. **Cross-domain redirect + low similarity is clean.** All five possessed links redirect to
   another registrable domain and score ≤ 0.04. The one honest redirect (rfc-editor, same domain)
   scores 0.62. Threshold 0.2 sits in a wide empty gap.
4. So v1 calls a link `possessed` only after a cross-domain redirect. Same-host replacement
   (Friendster, Picnik) is reported `alive`; detecting it is out of scope until there is a signal
   that does not also fire on Hacker News.
5. 403 from a site that is plainly alive (npm) is common. Other link checkers report it broken;
   `restless` exists for this.

Sample size is small (24 URLs). Treat the threshold as provisional and extend this table when a
wrong verdict is found.
