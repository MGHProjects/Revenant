/**
 * graveyard.ts — Revenant web UI entry point.
 *
 * Owns the page state and wires DOM events to the scan pipeline.
 * Extract runs in the browser (Vite tree-shakes the rest of core).
 * Batching: at most 3 URLs per POST /api/scan, 2 requests in flight.
 *
 * Requirements: 1.7, 4.5, 6.1, 6.4, 6.5, 6.6
 */

import type { Judgement, Link, Verdict } from '../src/core/types.js';
import { extract } from '../src/core/extract.js';
import { patch } from '../src/core/patch.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LINK_CAP = 200;
const BATCH_SIZE = 3;
const MAX_IN_FLIGHT = 2;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let judgements: Judgement[] = [];
let scanning = false;
/** Sound is off by default; the toggle flips this and sets data-sound on <html>. */
let soundEnabled = false;
/** URLs checked by the user to be excluded from the patch download. */
const excludedUrls = new Set<string>();
/** Source document text — kept so patch() can operate at download time. */
let currentSource = '';
/** Content kind of the current document — kept for MIME type on download. */
let currentKind: 'markdown' | 'html' = 'markdown';

// ---------------------------------------------------------------------------
// DOM references (all cast after DOMContentLoaded)
// ---------------------------------------------------------------------------

const urlInput     = document.getElementById('url-input')     as HTMLInputElement;
const textInput    = document.getElementById('text-input')    as HTMLTextAreaElement;
const scanBtn      = document.getElementById('scan-btn')      as HTMLButtonElement;
const sampleBtn    = document.getElementById('sample-btn')    as HTMLButtonElement;
const soundToggle  = document.getElementById('sound-toggle')  as HTMLButtonElement;
const sceneSection = document.getElementById('scene-section') as HTMLElement;
const ledgerSection = document.getElementById('ledger-section') as HTMLElement;
const ledgerBody   = document.getElementById('ledger-body')   as HTMLTableSectionElement;
const scene        = document.getElementById('scene')         as HTMLDivElement;
const sceneStatus  = document.getElementById('scene-status')  as HTMLParagraphElement;
const announcements = document.getElementById('announcements') as HTMLDivElement;
const resultSummary = document.getElementById('result-summary') as HTMLSpanElement;
const downloadBtn  = document.getElementById('download-btn')  as HTMLButtonElement;
const moonLit      = document.getElementById('moon-lit')      as SVGPathElement | null;

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

/** Return the trimmed active input, or '' if nothing is provided. */
function getActiveInput(): string {
  return urlInput.value.trim() || textInput.value.trim();
}

/** Detect content kind from the textarea contents. */
function detectSourceKind(text: string): 'markdown' | 'html' {
  const trimmed = text.trimStart();
  return trimmed.startsWith('<') ? 'html' : 'markdown';
}

/** Enable the Scan button only when there is input. */
function updateScanBtn(): void {
  scanBtn.disabled = getActiveInput().length === 0 || scanning;
}

// ---------------------------------------------------------------------------
// Announcement helper
// ---------------------------------------------------------------------------

/** Push a message into the aria-live region in a way that re-triggers read-out. */
function announce(message: string): void {
  // Clear and re-set forces the AT to re-announce even if text is identical.
  announcements.textContent = '';
  requestAnimationFrame(() => {
    announcements.textContent = message;
  });
}

// ---------------------------------------------------------------------------
// Moon progress indicator
// ---------------------------------------------------------------------------

/**
 * Update the moon SVG to show progress (0–1).
 * The lit path grows from a sliver (new moon) to a full circle.
 */
function setMoonProgress(progress: number): void {
  if (!moonLit) return;
  const p = Math.max(0, Math.min(1, progress));
  if (p >= 1) {
    moonLit.setAttribute('d', 'M30 2 A28 28 0 1 1 30 58 A28 28 0 1 1 30 2 Z');
    return;
  }
  if (p <= 0) {
    moonLit.setAttribute('d', 'M30 2 A28 28 0 0 1 30 2 Z');
    return;
  }
  // Wax from right to left: sweep from bottom to top on the right half,
  // expanding across the face as progress grows.
  const r = 28;
  const cx = 30;
  const cy = 30;
  // x offset of the terminator line (-r..+r), starts at +r (new) and moves left
  const x = cx + r * (1 - 2 * p);
  const h = Math.sqrt(Math.max(0, r * r - (x - cx) * (x - cx)));
  const y1 = cy - h;
  const y2 = cy + h;
  const largeArc = p > 0.5 ? 1 : 0;
  // Right half circle + terminator arc
  const d = [
    `M ${cx} ${cy - r}`,
    `A ${r} ${r} 0 1 1 ${cx} ${cy + r}`,        // right semicircle (always lit)
    `A ${r} ${r} 0 ${largeArc} ${p > 0.5 ? 1 : 0} ${cx} ${cy - r}`, // terminator
  ].join(' ');
  moonLit.setAttribute('d', d);
}

// ---------------------------------------------------------------------------
// Scene rendering helpers
// ---------------------------------------------------------------------------

/** SVG icons for each verdict, inlined to avoid extra requests. */
const verdictIcons: Record<Verdict, string> = {
  alive: `<svg class="grave-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <!-- Lit window -->
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <rect x="7" y="7" width="4" height="5" rx="1" fill="currentColor" opacity="0.8"/>
    <rect x="13" y="7" width="4" height="5" rx="1" fill="currentColor" opacity="0.8"/>
  </svg>`,

  dead: `<svg class="grave-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <!-- Tombstone -->
    <path d="M6 21 V10 Q6 4 12 4 Q18 4 18 10 V21 Z"/>
    <path d="M9 12 h6 M12 9 v6"/>
  </svg>`,

  possessed: `<svg class="grave-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <!-- Zombie hand rising -->
    <path d="M8 20 C8 16 10 14 10 11 Q10 9 12 9 Q14 9 14 11"/>
    <path d="M12 9 V6 Q12 4 13.5 4 Q15 4 15 6 V10"/>
    <path d="M15 7 Q15 5 16.5 5 Q18 5 18 7 V11"/>
    <path d="M18 9 Q18 7 19 7.5 Q20 8 20 10 V13"/>
    <path d="M8 14 C6 13 5 11 5 9 Q5 7 6.5 7 Q8 7 8 9 V14"/>
  </svg>`,

  restless: `<svg class="grave-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <!-- Fog patch -->
    <path d="M4 15 Q6 12 9 14 Q11 10 14 13 Q17 10 20 13"/>
    <path d="M2 18 Q5 15 8 17 Q11 14 14 17 Q17 14 22 17"/>
  </svg>`,
};

/** Render one grave marker into the scene. */
function renderGrave(judgement: Judgement): HTMLElement {
  const { verdict, link } = judgement;
  const el = document.createElement('div');
  el.className = 'grave';
  el.dataset['verdict'] = verdict;
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', `${verdict}: ${link.url}`);

  const shortUrl = link.url.replace(/^https?:\/\//, '').replace(/\/$/, '');

  el.innerHTML = `
    ${verdictIcons[verdict]}
    <span class="grave-label" title="${escapeHtml(link.url)}">${escapeHtml(shortUrl)}</span>
  `;

  // Keyboard: Enter/Space opens resurrection or the original URL
  el.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openJudgementTarget(judgement);
    }
  });
  el.addEventListener('click', () => openJudgementTarget(judgement));

  return el;
}

function openJudgementTarget(j: Judgement): void {
  const target = j.resurrection ?? j.link.url;
  window.open(target, '_blank', 'noopener,noreferrer');
}

/** Render a row in the accessible ledger table (Requirements 6.4, 6.5, 6.6, 4.5). */
function renderLedgerRow(judgement: Judgement): HTMLTableRowElement {
  const { verdict, link, reason, epitaph, resurrection } = judgement;
  const tr = document.createElement('tr');

  const verdictLabel: Record<Verdict, string> = {
    alive:     'Alive',
    dead:      'Dead',
    possessed: 'Possessed',
    restless:  'Restless',
  };

  const epitaphText = epitaph === 'unavailable' || !epitaph
    ? '—'
    : `${epitaph.first} – ${epitaph.last}`;

  const resurrectionHtml = resurrection
    ? `<a href="${escapeHtml(resurrection)}" target="_blank" rel="noopener noreferrer"
         title="${escapeHtml(resurrection)}">Wayback snapshot</a>`
    : '—';

  // Exclude checkbox — only meaningful for dead/possessed (others can't be patched anyway,
  // but we show it on all rows so the table structure stays consistent).
  const checkboxId = `exclude-${CSS.escape(link.url)}`;
  const isExcluded = excludedUrls.has(link.url);

  // Resurrect button — only relevant for dead/possessed (Req 6.4, 6.5).
  const canResurrect = (verdict === 'dead' || verdict === 'possessed');
  let resurrectCellHtml: string;
  if (canResurrect && resurrection) {
    resurrectCellHtml = `
      <button type="button" class="btn btn-ghost resurrect-btn"
        data-url="${escapeHtml(resurrection)}"
        aria-label="Resurrect — open archived snapshot for ${escapeHtml(link.url)}">
        Resurrect
      </button>`;
  } else if (canResurrect) {
    // No archived version available — disabled (Req 6.5)
    resurrectCellHtml = `
      <button type="button" class="btn btn-ghost resurrect-btn" disabled
        aria-disabled="true"
        aria-label="No archived version available for ${escapeHtml(link.url)}">
        No archived version available
      </button>`;
  } else {
    resurrectCellHtml = '—';
  }

  tr.innerHTML = `
    <td>
      <span class="verdict-badge" data-verdict="${verdict}">
        ${verdictIcons[verdict].replace('class="grave-icon"', 'class="verdict-icon"')}
        ${verdictLabel[verdict]}
      </span>
    </td>
    <td class="url-cell">
      <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer"
         title="${escapeHtml(link.url)}">${escapeHtml(truncateUrl(link.url))}</a>
    </td>
    <td>${escapeHtml(reason)}</td>
    <td class="epitaph-cell">${escapeHtml(epitaphText)}</td>
    <td class="resurrection-cell">${resurrectionHtml}</td>
    <td class="exclude-cell">
      <label class="exclude-label">
        <input type="checkbox" id="${escapeHtml(checkboxId)}"
          class="exclude-checkbox"
          data-url="${escapeHtml(link.url)}"
          aria-label="Exclude ${escapeHtml(link.url)} from patch"
          ${isExcluded ? 'checked' : ''}
        />
        <span class="sr-only">Exclude from patch</span>
      </label>
    </td>
    <td class="resurrect-cell">${resurrectCellHtml}</td>
  `;

  // Wire the resurrect button (can't use inline onclick with CSP).
  const resurrectBtn = tr.querySelector<HTMLButtonElement>('.resurrect-btn:not([disabled])');
  if (resurrectBtn && resurrection) {
    resurrectBtn.addEventListener('click', () => {
      window.open(resurrection, '_blank', 'noopener,noreferrer');
    });
  }

  // Wire the exclude checkbox to update state.
  const checkbox = tr.querySelector<HTMLInputElement>('.exclude-checkbox');
  if (checkbox) {
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        excludedUrls.add(link.url);
      } else {
        excludedUrls.delete(link.url);
      }
    });
  }

  return tr;
}

/** Truncate a URL for display (keeps it readable without overflowing the cell). */
function truncateUrl(url: string, maxLen = 70): string {
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen - 1) + '…';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Results summary
// ---------------------------------------------------------------------------

function updateSummary(): void {
  const counts: Record<Verdict, number> = { alive: 0, dead: 0, possessed: 0, restless: 0 };
  for (const j of judgements) counts[j.verdict]++;
  const total = judgements.length;
  resultSummary.textContent =
    `${total} link${total !== 1 ? 's' : ''} — ` +
    `${counts.alive} alive, ${counts.dead} dead, ` +
    `${counts.possessed} possessed, ${counts.restless} restless`;
}

// ---------------------------------------------------------------------------
// Announcement helpers for batch results
// ---------------------------------------------------------------------------

/** Announce a batched scan result to screen readers via the aria-live region. */
function announceResults(batch: Judgement[]): void {
  const counts: Record<Verdict, number> = { alive: 0, dead: 0, possessed: 0, restless: 0 };
  for (const j of batch) counts[j.verdict]++;
  const parts: string[] = [];
  if (counts.alive)     parts.push(`${counts.alive} alive`);
  if (counts.dead)      parts.push(`${counts.dead} dead`);
  if (counts.possessed) parts.push(`${counts.possessed} possessed`);
  if (counts.restless)  parts.push(`${counts.restless} restless`);
  announce(parts.join(', ') + '.');
}

// ---------------------------------------------------------------------------
// Scan flow
// ---------------------------------------------------------------------------

/**
 * Detect whether the URL field holds a bare `owner/repo` slug.
 * Matches GitHub-style slugs; everything else with a scheme is a page URL.
 */
function isRepoSlug(s: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s);
}

/**
 * Show a dismissible error banner inside the scene area.
 */
function showError(message: string): void {
  const existing = sceneSection.querySelector('.scan-error');
  if (existing) existing.remove();
  const el = document.createElement('p');
  el.className = 'scan-error';
  el.setAttribute('role', 'alert');
  el.textContent = `⚠ ${message}`;
  sceneSection.prepend(el);
  announce(message);
}

/**
 * Render newly-arrived judgements into the scene (graveyard SVG/DOM layer).
 * Task 9.3 will flesh this out further; here we delegate to appendResult
 * which already adds graves and ledger rows.
 */
function renderScene(batch: Judgement[]): void {
  for (const j of batch) {
    scene.appendChild(renderGrave(j));
  }
}

/**
 * Render newly-arrived judgements into the accessible ledger table.
 * Reveals the ledger section on the first call (Requirement 6.6).
 */
function renderLedger(batch: Judgement[]): void {
  for (const j of batch) {
    ledgerBody.appendChild(renderLedgerRow(j));
  }
  // Show ledger section once results start arriving.
  ledgerSection.hidden = false;
}

/**
 * Run at most `maxInFlight` async tasks concurrently from an array of
 * thunks, calling `onResult` with each resolved value as it arrives.
 */
async function pooledMap<T>(
  thunks: Array<() => Promise<T>>,
  maxInFlight: number,
  onResult: (result: T) => void,
): Promise<void> {
  let idx = 0;

  async function runNext(): Promise<void> {
    if (idx >= thunks.length) return;
    const myIdx = idx++;
    const result = await thunks[myIdx]!();
    onResult(result);
    await runNext();
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(maxInFlight, thunks.length); i++) {
    workers.push(runNext());
  }
  await Promise.all(workers);
}

/**
 * Split an array into chunks of at most `size`.
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Called when the user clicks Scan.
 * 1. Detect input kind (markdown/html from textarea, or url/repo from URL field).
 * 2. For url/repo: POST /api/resolve to fetch source text server-side.
 * 3. Run extract() in the browser.
 * 4. Apply 200-link cap.
 * 5. Send batches of 3 URLs to POST /api/scan, 2 in flight at a time.
 * 6. Append each batch's judgements to state; call renderScene + renderLedger.
 */
async function startScan(): Promise<void> {
  const rawInput = getActiveInput();
  if (!rawInput || scanning) return;

  // Reset state
  judgements = [];
  excludedUrls.clear();
  scanning = true;
  scanBtn.disabled = true;

  // Clear previous results
  sceneSection.hidden = false;
  ledgerSection.hidden = true;   // revealed on first batch arrival
  scene.innerHTML = '';
  ledgerBody.innerHTML = '';
  // Remove any stale banners
  for (const el of Array.from(sceneSection.querySelectorAll('.scan-error, .cap-notice'))) {
    el.remove();
  }
  updateSummary();
  setMoonProgress(0);
  sceneStatus.textContent = 'Scanning…';
  announce('Scan started.');

  // ------------------------------------------------------------------
  // Step 1 — determine source text and content kind
  // ------------------------------------------------------------------
  let sourceText: string;
  let contentKind: 'markdown' | 'html';

  if (urlInput.value.trim()) {
    const urlOrRepo = urlInput.value.trim();
    const resolveKind: 'url' | 'repo' = isRepoSlug(urlOrRepo) ? 'repo' : 'url';

    sceneStatus.textContent = resolveKind === 'repo'
      ? 'Fetching repository README…'
      : 'Fetching page…';

    let resolveRes: Response;
    try {
      resolveRes = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: urlOrRepo, kind: resolveKind }),
      });
    } catch (err) {
      showError('Network error while resolving the URL. Check your connection and try again.');
      scanning = false;
      updateScanBtn();
      return;
    }

    if (!resolveRes.ok) {
      let errorMsg = `Could not load the page (HTTP ${resolveRes.status}).`;
      try {
        const body = await resolveRes.json() as { error?: string };
        if (body.error) errorMsg = body.error;
      } catch { /* ignore parse failure */ }
      showError(errorMsg);
      scanning = false;
      updateScanBtn();
      return;
    }

    let resolved: { source: string; kind: 'markdown' | 'html' };
    try {
      resolved = await resolveRes.json() as { source: string; kind: 'markdown' | 'html' };
    } catch {
      showError('Unexpected response from the server while resolving the page.');
      scanning = false;
      updateScanBtn();
      return;
    }

    sourceText = resolved.source;
    contentKind = resolved.kind;
  } else {
    sourceText = textInput.value;
    contentKind = detectSourceKind(sourceText);
  }

  // Persist for download use
  currentSource = sourceText;
  currentKind = contentKind;

  // ------------------------------------------------------------------
  // Step 2 — extract links in the browser
  // ------------------------------------------------------------------
  sceneStatus.textContent = 'Extracting links…';
  let links: Link[];
  try {
    links = extract(sourceText, contentKind);
  } catch (err) {
    showError('Could not parse the document. Make sure it is valid Markdown or HTML.');
    scanning = false;
    updateScanBtn();
    return;
  }

  if (links.length === 0) {
    sceneStatus.textContent = 'No HTTP/HTTPS links found in the document.';
    announce('No links found.');
    scanning = false;
    updateScanBtn();
    return;
  }

  // ------------------------------------------------------------------
  // Step 3 — apply 200-link cap
  // ------------------------------------------------------------------
  const totalFound = links.length;
  const capped = totalFound > LINK_CAP;
  if (capped) {
    links = links.slice(0, LINK_CAP);
    const notice = document.createElement('p');
    notice.className = 'cap-notice';
    notice.setAttribute('role', 'alert');
    notice.textContent =
      `Showing first ${LINK_CAP} of ${totalFound} links — only the first ${LINK_CAP} will be scanned.`;
    sceneSection.prepend(notice);
    announce(`200-link cap reached. Scanning the first ${LINK_CAP} of ${totalFound} links.`);
  }

  sceneStatus.textContent = `Scanning ${links.length} link${links.length !== 1 ? 's' : ''}…`;

  // ------------------------------------------------------------------
  // Step 4 — batch and dispatch with 2-in-flight concurrency
  // ------------------------------------------------------------------
  const urls = links.map(l => l.url);
  const batches = chunk(urls, BATCH_SIZE);
  let batchesDone = 0;

  const thunks = batches.map(batch => async (): Promise<Judgement[]> => {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: batch }),
    });

    if (!res.ok) {
      // Return restless judgements so the UI still advances
      return batch.map(url => ({
        link: { url, spans: [] },
        verdict: 'restless' as Verdict,
        reason: `Scan error: HTTP ${res.status}`,
      }));
    }

    const data = await res.json() as { judgements?: Judgement[]; error?: string };
    if (!data.judgements) {
      return batch.map(url => ({
        link: { url, spans: [] },
        verdict: 'restless' as Verdict,
        reason: data.error ?? 'Unknown scan error',
      }));
    }

    // Re-attach the full Link objects (the API returns spans: [])
    // so patch/download can work later; match by URL.
    const linkByUrl = new Map(links.map(l => [l.url, l]));
    return data.judgements.map(j => ({
      ...j,
      link: linkByUrl.get(j.link.url) ?? j.link,
    }));
  });

  try {
    await pooledMap(thunks, MAX_IN_FLIGHT, (batchJudgements) => {
      judgements.push(...batchJudgements);
      renderScene(batchJudgements);
      renderLedger(batchJudgements);
      updateSummary();
      announceResults(batchJudgements);

      batchesDone++;
      setMoonProgress(batchesDone / batches.length);
    });
  } catch (err) {
    showError('A network error occurred during scanning. Some results may be missing.');
  }

  // ------------------------------------------------------------------
  // Step 5 — finish
  // ------------------------------------------------------------------
  scanning = false;
  updateScanBtn();
  setMoonProgress(1);
  const capNote = capped ? ` (${LINK_CAP}-URL cap reached; ${totalFound} total found)` : '';
  sceneStatus.textContent = `Scan complete — ${judgements.length} link${judgements.length !== 1 ? 's' : ''} checked${capNote}.`;
  announce(`Scan complete. ${judgements.length} links checked${capNote}.`);
  downloadBtn.hidden = false;
}

// ---------------------------------------------------------------------------
// Sample document loader
// ---------------------------------------------------------------------------

async function loadSample(): Promise<void> {
  try {
    sampleBtn.disabled = true;
    // The sample file is served by Vite's dev server / Worker static assets.
    const res = await fetch('/samples/haunted-readme.md');
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    textInput.value = text;
    urlInput.value = '';
    updateScanBtn();
    textInput.focus();
    announce('Sample document loaded.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    announce(`Could not load sample: ${msg}`);
  } finally {
    sampleBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Keyboard navigation through graves (arrow keys)
// ---------------------------------------------------------------------------

scene.addEventListener('keydown', (e: KeyboardEvent) => {
  const graves = Array.from(scene.querySelectorAll<HTMLElement>('.grave'));
  if (!graves.length) return;
  const focused = document.activeElement as HTMLElement;
  const idx = graves.indexOf(focused);
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    graves[(idx + 1) % graves.length]?.focus();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    graves[(idx - 1 + graves.length) % graves.length]?.focus();
  }
});

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

urlInput.addEventListener('input', updateScanBtn);
textInput.addEventListener('input', updateScanBtn);

// Mutual exclusion: clear the other field when typing in one
urlInput.addEventListener('input', () => {
  if (urlInput.value.trim()) textInput.value = '';
});
textInput.addEventListener('input', () => {
  if (textInput.value.trim()) urlInput.value = '';
});

scanBtn.addEventListener('click', () => void startScan());
sampleBtn.addEventListener('click', () => void loadSample());

// ---------------------------------------------------------------------------
// Download patched document (Requirements 4.1, 4.5, 6.6)
// ---------------------------------------------------------------------------

downloadBtn.addEventListener('click', () => {
  if (!currentSource) return;

  const patched = patch(currentSource, judgements, new Set(excludedUrls));

  const mimeType = currentKind === 'html' ? 'text/html' : 'text/markdown';
  const extension = currentKind === 'html' ? '.html' : '.md';
  const blob = new Blob([patched], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `revenant-patched${extension}`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Revoke the object URL after a short delay to allow the download to start.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

// ---------------------------------------------------------------------------
// Sound toggle (sound is off by default — Requirement 6.8)
// ---------------------------------------------------------------------------

/**
 * Toggle sound on/off. The UI has no actual audio yet; this stub sets the
 * `data-sound` attribute on <html> so future audio code has a hook, and
 * keeps `aria-pressed` in sync so the button state is screen-reader visible.
 */
function toggleSound(): void {
  soundEnabled = !soundEnabled;
  document.documentElement.dataset['sound'] = soundEnabled ? 'on' : 'off';
  soundToggle.setAttribute('aria-pressed', String(soundEnabled));

  // Update visible label and emoji so state is not colour-only.
  const emojiSpan  = soundToggle.querySelector<HTMLElement>('span[aria-hidden]');
  const labelSpan  = soundToggle.querySelector<HTMLElement>('.sound-toggle-label');
  if (emojiSpan)  emojiSpan.textContent  = soundEnabled ? '🔔' : '🔇';
  if (labelSpan)  labelSpan.textContent  = soundEnabled ? 'Sound on'  : 'Sound off';
  soundToggle.title = soundEnabled
    ? 'Sound is on — click to mute'
    : 'Sound is off — click to enable';
}

soundToggle.addEventListener('click', toggleSound);

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------
updateScanBtn();
