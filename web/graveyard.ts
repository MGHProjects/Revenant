/**
 * graveyard.ts: the Revenant page. Extract, batching, state, ledger, download, sound, events.
 *
 * Extract runs in the browser; the Worker judges at most 3 URLs per request and the page keeps
 * at most 2 requests in flight (free-plan limits, see tech.md). All DOM is built with
 * textContent / setAttribute: nothing from a document or the network reaches innerHTML.
 */

import type { Judgement, Link, Verdict } from '../src/core/types.js';
import { extract } from '../src/core/extract.js';
import sample from '../samples/haunted-readme.md?raw';
import {
  LABEL,
  createPlot,
  hostOf,
  noSnapshotText,
  raisePlot,
  setMoon,
  showInscription,
  toGraveView,
  type GraveView,
} from './scene.js';
import { mistOpacity } from './mist.js';
import { chunk, mergeJudgement, retryIndexes } from './ask-again.js';
import { NARROW_MAX_WIDTH, balancedColumns, maxColumns } from './yard-columns.js';
import { isRepoSlug, parseScanParams, searchAfterScan, type ScanOrigin } from './scan-address.js';
import { resultHeadline } from './result-headline.js';
import { COPY_FAILED_MESSAGE, copiedMessage, fixSteps, openOnGithubLabel, patchedDocument } from './fix-steps.js';
import { githubFileUrl } from './github-file.js';

const LINK_CAP = 200;
const BATCH_SIZE = 3;
const MAX_IN_FLIGHT = 2;
/** Minimum gap between two batches appearing, so a burst of replies still rises batch by batch. */
const REVEAL_GAP_MS = 900;
const EMPTY_ERROR = 'Paste a document or enter an address first.';

const EMPTY_HEADLINE = 'Bring your dead links back.';

type Kind = 'markdown' | 'html';
/** What a scan reads: the hero's address field, the bundled sample or the textarea. */
type Mode = 'address' | 'sample' | 'text';
type Field = 'address' | 'source';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const yard = $('yard');
const ground = $('ground');
const statusEl = $('status');
const live = $('live');
const source = $<HTMLTextAreaElement>('source');
const address = $<HTMLInputElement>('address');
const sourceError = $('source-error');
const addressError = $('address-error');
const heroForm = $('hero-form');
const intro = $('intro');
const tryRow = $('try');
const scanBtn = $<HTMLButtonElement>('scan');
const downloadBtn = $<HTMLButtonElement>('download');
const copyPatchedBtn = $<HTMLButtonElement>('copy-patched');
const patchedFallback = $<HTMLTextAreaElement>('patched-fallback');
const ghLink = $<HTMLAnchorElement>('gh-link');
const stepsEl = $('fix-steps');
const soundBtn = $<HTMLButtonElement>('sound');
const rowsEl = $('rows');
const sampleScanBtn = $<HTMLButtonElement>('scan-sample');
const copyBtn = $<HTMLButtonElement>('copy-link');
const copyFallback = $<HTMLInputElement>('copy-fallback');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Indexed by document position; holes while a later batch has returned before an earlier one. */
let views: Array<GraveView | undefined> = [];
let judgements: Array<Judgement | undefined> = [];
let selected = -1;
let currentSource = '';
let currentKind: Kind = 'markdown';
/** The repo (owner/repo) and README file of the running scan, when it came from a repo address. */
let currentRepo: string | undefined;
let currentFile: string | undefined;
let scanning = false;
/** The final headline is on screen: a judgement replaced afterwards (Ask again) updates it. */
let finished = false;
/** Links with no judgement because their batch failed, and how many links the document had. */
let scanFailed = 0;
let scanFound = 0;
/** Which field the running scan came from: its error paragraph is the one shown. */
let errorField: Field = 'source';
/** Links in the running scan; 0 before any scan, which keeps the mist at 1. */
let scanTotal = 0;
/** Bumped by every new scan: answers that arrive for an older generation are discarded. */
let scanGen = 0;
/** Document positions with an Ask again request in flight. */
const asking = new Set<number>();
/** Links whose Patch checkbox is unchecked: passed to patch() as `excluded`. */
const excluded = new Set<string>();

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const reduced = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const present = (): GraveView[] => views.filter((v): v is GraveView => v !== undefined);
const plotButtons = (): HTMLButtonElement[] => Array.from(yard.querySelectorAll<HTMLButtonElement>('.plot'));
const plotAt = (i: number): HTMLButtonElement | undefined =>
  plotButtons().find(b => b.dataset['i'] === String(i));

function tallies(): Record<Verdict, number> {
  const c: Record<Verdict, number> = { alive: 0, dead: 0, possessed: 0, restless: 0 };
  for (const v of present()) c[v.verdict]++;
  return c;
}

function count(): string {
  return Object.entries(tallies())
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
}

/** Tally, inscription band and the hero's sample button follow whether any plot exists yet. */
function syncChrome(): void {
  const has = present().length > 0;
  $('tally').hidden = !has;
  $('inscription').hidden = !has;
  // Before results the hero invites a first scan: explanation, address form, Try row, sample.
  // While scanning it shows progress only. With results it keeps the address form, below the
  // tally, so another address can be scanned, and drops the onboarding (explanation, Try row).
  intro.hidden = scanning || has;
  tryRow.hidden = scanning || has;
  heroForm.hidden = scanning;
}

/** Mist = links still waiting plus restless ones, over all links (web/mist.ts). */
function renderMist(restless: number): void {
  ground.style.setProperty('--mist', String(mistOpacity(scanTotal, present().length, restless)));
}

/** The result sentence from the judgements on screen; a replaced judgement changes it too. */
function renderHeadline(): void {
  const c = tallies();
  const fixable = present().filter(v => (v.verdict === 'dead' || v.verdict === 'possessed') && v.snap).length;
  const text = resultHeadline({
    total: scanTotal, dead: c.dead, possessed: c.possessed, fixable, restless: c.restless, failed: scanFailed,
  });
  const cap = scanFound > LINK_CAP ? ` Only the first ${LINK_CAP} of ${scanFound} links were scanned.` : '';
  statusEl.textContent = text + cap;
}

function renderTally(): void {
  syncChrome();
  const c = tallies();
  for (const k of Object.keys(c) as Verdict[]) $(`n-${k}`).textContent = String(c[k]);
  renderMist(c.restless);
  if (finished) renderHeadline();
}

// ---------------------------------------------------------------------------
// Plots
// ---------------------------------------------------------------------------

const narrowQuery = window.matchMedia(`(max-width: ${NARROW_MAX_WIDTH}px)`);
let layoutFrame = 0;

/** Sets --cols from the plot count and the room, and titles host labels that are still clipped. */
function layoutYard(): void {
  layoutFrame = 0;
  const n = yard.childElementCount;
  const cols = balancedColumns(n, maxColumns(yard.clientWidth, narrowQuery.matches));
  yard.style.setProperty('--cols', String(cols));
  for (const b of plotButtons()) {
    const host = b.querySelector<HTMLElement>('.host');
    if (!host) continue;
    const cut =
      host.scrollHeight > host.clientHeight + 1 ||
      Array.from(host.querySelectorAll<HTMLElement>('.hpart')).some((p) => p.scrollWidth > p.clientWidth + 1);
    if (cut) b.title = host.textContent ?? '';
    else b.removeAttribute('title');
  }
}

/** One layout per frame, however many plots or resize events arrive. */
function scheduleLayout(): void {
  if (!layoutFrame) layoutFrame = requestAnimationFrame(layoutYard);
}

new ResizeObserver(scheduleLayout).observe(yard);

// The inscription band's height varies with its content; scroll-padding-bottom follows it so a
// focused plot is never hidden under the stuck band (0 while the band is hidden).
const inscriptionBand = $('inscription');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--ins-h', `${inscriptionBand.offsetHeight}px`);
}).observe(inscriptionBand);
narrowQuery.addEventListener('change', scheduleLayout);

/** Insert at the link's document position, whatever order batches come back in. */
function addPlot(v: GraveView): void {
  views[v.index] = v;
  // rise delay: the link's position within its batch times 110 ms
  const li = createPlot(v, (v.index % BATCH_SIZE) * 110);
  const next = plotButtons().find(b => Number(b.dataset['i']) > v.index);
  if (next) yard.insertBefore(li, next.parentElement);
  else yard.append(li);
  scheduleLayout();
  if (selected < 0) {
    // roving tabindex: the first plot in document order is the tab stop until one is selected
    plotButtons().forEach((b, n) => { b.tabIndex = n === 0 ? 0 : -1; });
  }
}

/** Draws the inscription and keeps the Ask again button in its busy state while a request runs. */
function renderInscription(v: GraveView | undefined): void {
  showInscription(v);
  if (!v || !asking.has(v.index)) return;
  const btn = document.getElementById('ask-again') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Asking…';
  }
}

let revealFrame = 0;

/**
 * Scrolls the selected plot, labels and ground line included, above the stuck inscription band.
 * Runs in a frame after the inscription redraw so the band has its final height, and sets --ins-h
 * itself because the ResizeObserver fires after requestAnimationFrame callbacks. The plot is looked
 * up again then, since Ask again may have replaced the element.
 */
function revealSelected(): void {
  if (revealFrame) cancelAnimationFrame(revealFrame);
  revealFrame = requestAnimationFrame(() => {
    revealFrame = 0;
    const plot = plotAt(selected);
    if (!plot) return;
    document.documentElement.style.setProperty('--ins-h', `${inscriptionBand.offsetHeight}px`);
    plot.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  });
}

function select(i: number, focus = false): void {
  const v = views[i];
  if (!v) return;
  selected = i;
  for (const b of plotButtons()) {
    const on = b.dataset['i'] === String(i);
    b.tabIndex = on ? 0 : -1;
    b.setAttribute('aria-pressed', String(on));
    if (on && focus) b.focus();
  }
  renderInscription(v);
  revealSelected();
}

function resurrect(i: number, focusLink = false): void {
  const v = views[i];
  if (!v || !v.snap || v.raised) return;
  v.raised = true;
  const plot = plotAt(i);
  if (plot) raisePlot(plot, v, !reduced());
  select(i);
  if (focusLink) document.querySelector<HTMLAnchorElement>('#ins-action a')?.focus();
  live.textContent = `${v.host} raised. The archived page is ready to open.`;
}

/** At scan end: the first dead link, else the first link with a snapshot, else nothing. */
function selectDefault(): void {
  if (selected >= 0) return;
  const all = present();
  const pick = all.find(v => v.verdict === 'dead') ?? all.find(v => v.snap);
  if (pick) select(pick.index);
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

function createRow(v: GraveView): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'lrow';
  tr.setAttribute('role', 'row');
  tr.dataset['i'] = String(v.index);

  const link = document.createElement('td');
  const host = document.createElement('span');
  host.className = 'lhost';
  host.textContent = v.host;
  const url = document.createElement('span');
  url.className = 'lurl mono';
  url.textContent = v.url;
  link.append(host, url);

  const verdict = document.createElement('td');
  verdict.className = `tag lverdict ${v.verdict}`;
  verdict.textContent = LABEL[v.verdict];

  const why = document.createElement('td');
  why.className = 'lwhy';
  why.textContent = v.reason;

  const archived = document.createElement('td');
  archived.className = 'lseen';
  if (v.snap) {
    const a = document.createElement('a');
    a.href = v.snap;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = v.seen ?? 'Archived copy';
    archived.append(a);
  } else {
    archived.classList.add('lnone');
    archived.textContent = noSnapshotText(v);
  }

  const patchCell = document.createElement('td');
  if (v.snap) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !excluded.has(v.url);
    box.dataset['url'] = v.url;
    box.setAttribute('aria-label', `Patch ${hostOf(v.url)} in the download`);
    patchCell.append(box);
  }

  for (const td of [link, verdict, why, archived, patchCell]) td.setAttribute('role', 'cell');
  tr.append(link, verdict, why, archived, patchCell);
  return tr;
}

/** Insert the row at the link's document position, like its plot. */
function addRow(v: GraveView): void {
  $('ledger').hidden = false;
  const tr = createRow(v);
  const next = Array.from(rowsEl.querySelectorAll<HTMLTableRowElement>('tr')).find(r => Number(r.dataset['i']) > v.index);
  if (next) rowsEl.insertBefore(tr, next);
  else rowsEl.append(tr);
  renderPatchNote();
}

const patchCount = (): number => present().filter(v => v.snap && !excluded.has(v.url)).length;

function renderPatchNote(): void {
  const n = patchCount();
  $('patch-note').textContent = `${n} ${plural(n, 'link will point to its archived copy', 'links will point to their archived copies')} in the download.`;
  downloadBtn.disabled = scanning || !n;
  copyPatchedBtn.disabled = downloadBtn.disabled;
}

/** The GitHub link and the steps beside the buttons: three steps only when the link is shown. */
function renderFix(): void {
  const [owner, repo] = (currentRepo ?? '').split('/');
  const href = owner && repo && currentFile ? githubFileUrl(owner, repo, currentFile) : undefined;
  if (href && currentFile) {
    ghLink.href = href;
    ghLink.textContent = openOnGithubLabel(currentFile);
    ghLink.hidden = false;
  } else {
    ghLink.removeAttribute('href');
    ghLink.textContent = '';
    ghLink.hidden = true;
  }
  stepsEl.replaceChildren(...fixSteps(href !== undefined).map(text => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
}

rowsEl.addEventListener('change', e => {
  const box = e.target as HTMLInputElement;
  const url = box.dataset['url'];
  if (url === undefined) return;
  if (box.checked) excluded.delete(url);
  else excluded.add(url);
  // the same URL may appear in several rows: keep their boxes in step
  rowsEl.querySelectorAll<HTMLInputElement>('input[data-url]').forEach(other => {
    if (other.dataset['url'] === url) other.checked = box.checked;
  });
  renderPatchNote();
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function showError(message: string, invalid = false, field: Field = errorField): void {
  const p = field === 'address' ? addressError : sourceError;
  const input = field === 'address' ? address : source;
  clearError();
  p.textContent = message;
  p.hidden = false;
  input.setAttribute('aria-invalid', String(invalid));
  input.setAttribute('aria-describedby', p.id);
  live.textContent = message;
}

function clearError(): void {
  for (const [p, input] of [[sourceError, source], [addressError, address]] as const) {
    p.hidden = true;
    p.textContent = EMPTY_ERROR;
    input.setAttribute('aria-invalid', 'false');
    input.removeAttribute('aria-describedby');
  }
}
// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function looksLikeHtml(text: string): boolean {
  return /^\s*(<!doctype html|<[a-z][a-z0-9-]*(\s|>|\/>))/i.test(text);
}

async function resolveAddress(input: string): Promise<{ source: string; kind: Kind; file?: string } | { error: string }> {
  const kind = isRepoSlug(input) ? 'repo' : 'url';
  let res: Response;
  try {
    res = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, kind }),
    });
  } catch {
    return { error: 'Could not reach the Revenant server. Check your connection and try again.' };
  }
  let body: { source?: unknown; kind?: unknown; file?: unknown; error?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch { /* handled below */ }
  if (!res.ok || typeof body.source !== 'string') {
    const detail = typeof body.error === 'string' ? body.error.replace(/\.$/, '') : `HTTP ${res.status}`;
    // Worker messages for page URLs are already full sentences. Repo and unknown errors are not.
    if (/^(Could not load that address|That address is not allowed)/.test(detail)) return { error: `${detail}.` };
    return { error: `Could not load that address: ${detail}.` };
  }
  const file = kind === 'repo' && typeof body.file === 'string' && body.file !== '' ? body.file : undefined;
  return { source: body.source, kind: body.kind === 'html' ? 'html' : 'markdown', ...(file ? { file } : {}) };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

type BatchResult = { ok: true; judgements: Judgement[] } | { ok: false; detail: string };

async function judgeBatch(urls: string[]): Promise<BatchResult> {
  let res: Response;
  try {
    res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
    });
  } catch {
    return { ok: false, detail: 'the network failed' };
  }
  if (!res.ok) return { ok: false, detail: `the server answered HTTP ${res.status}` };
  try {
    const data = (await res.json()) as { judgements?: unknown };
    if (!Array.isArray(data.judgements)) return { ok: false, detail: 'the server sent an unexpected reply' };
    return { ok: true, judgements: data.judgements as Judgement[] };
  } catch {
    return { ok: false, detail: 'the server sent an unexpected reply' };
  }
}

async function runPool(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) await tasks[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

function resetScene(): void {
  yard.replaceChildren();
  scheduleLayout();
  views = [];
  judgements = [];
  selected = -1;
  excluded.clear();
  asking.clear();
  scanTotal = 0;
  scanFailed = 0;
  scanFound = 0;
  finished = false;
  showInscription(undefined);
  $('ledger').hidden = true;
  rowsEl.replaceChildren();
  downloadBtn.disabled = true;
  copyPatchedBtn.disabled = true;
  patchedFallback.hidden = true;
  currentRepo = undefined;
  currentFile = undefined;
  renderFix();
  setMoon(0);
  renderTally();
}

async function scan(mode: Mode): Promise<void> {
  if (scanning) return;
  scanBtn.disabled = true;
  scanning = true;
  scanGen++;
  errorField = mode === 'address' ? 'address' : 'source';
  clearError();
  resetScene();
  copyBtn.hidden = true;
  copyFallback.hidden = true;
  // the hero input hides while scanning: park focus on the status heading so it is not lost
  if (heroForm.contains(document.activeElement) || tryRow.contains(document.activeElement)) statusEl.focus();
  try {
    await runScan(mode);
  } finally {
    scanning = false;
    scanBtn.disabled = false;
    renderPatchNote();
    syncChrome();
  }
}

/** The hero's one-click path: load the bundled sample, clear the address, scan. */
function scanSample(): void {
  if (scanning) return;
  source.value = sample;
  address.value = '';
  void scan('sample');
}

/**
 * Writes the scan's address into the query string (replaceState: no history entry) and shows
 * Copy link when the result has one. A textarea scan clears the scan parameters instead.
 */
function writeAddress(origin: ScanOrigin): void {
  const { search, shareable } = searchAfterScan(location.search, origin);
  if (search !== location.search) history.replaceState(history.state, '', location.pathname + search + location.hash);
  copyBtn.hidden = !shareable;
  copyFallback.hidden = true;
}

async function runScan(mode: Mode): Promise<void> {
  let text: string;
  let kind: Kind;
  if (mode === 'address') {
    const addr = address.value.trim();
    statusEl.textContent = 'Fetching the document.';
    const resolved = await resolveAddress(addr);
    if ('error' in resolved) {
      statusEl.textContent = EMPTY_HEADLINE;
      showError(resolved.error);
      return;
    }
    text = resolved.source;
    kind = resolved.kind;
    writeAddress({ kind: 'address', address: addr });
    if (isRepoSlug(addr) && resolved.file) {
      currentRepo = addr;
      currentFile = resolved.file;
    }
    renderFix();
  } else {
    writeAddress(mode === 'sample' ? { kind: 'sample' } : { kind: 'text' });
    text = source.value;
    kind = looksLikeHtml(text) ? 'html' : 'markdown';
  }
  currentSource = text;
  currentKind = kind;

  const found = extract(text, kind);
  if (found.length === 0) {
    statusEl.textContent = EMPTY_HEADLINE;
    showError('No links found. Only http and https links are scanned.');
    return;
  }
  const gen = scanGen;
  const links: Link[] = found.slice(0, LINK_CAP);
  const total = links.length;
  scanTotal = total;
  scanFound = found.length;
  renderMist(0);
  const capNote = found.length > LINK_CAP ? ` A scan covers up to ${LINK_CAP}.` : '';
  statusEl.textContent = found.length > LINK_CAP
    ? `Judging ${total} of ${found.length} links.${capNote}`
    : `Judging ${total} ${plural(total, 'link', 'links')}.`;

  let done = 0;
  let failed = 0;
  let firstFailure = '';
  let lastReveal = 0;
  let reveal: Promise<void> = Promise.resolve();

  const show = async (from: number, result: BatchResult, size: number): Promise<void> => {
    if (!reduced()) await sleep(Math.max(0, lastReveal + REVEAL_GAP_MS - Date.now()));
    lastReveal = Date.now();
    done += size;
    if (result.ok) {
      result.judgements.slice(0, size).forEach((j, n) => {
        const index = from + n;
        const link = links[index]!;
        const full: Judgement = { ...j, link };
        judgements[index] = full;
        const view = toGraveView(full, index);
        addPlot(view);
        addRow(view);
      });
      setMoon(done / total);
      renderTally();
      live.textContent = `${done} of ${total} ${plural(total, 'link', 'links')} judged: ${count()}.`;
    } else {
      failed += size;
      scanFailed = failed;
      firstFailure ||= result.detail;
      setMoon(done / total);
      showError(`${failed} ${plural(failed, 'link', 'links')} could not be checked (${firstFailure}). The rest were judged.`);
    }
  };

  const tasks = Array.from({ length: Math.ceil(total / BATCH_SIZE) }, (_, b) => async (): Promise<void> => {
    const from = b * BATCH_SIZE;
    const batch = links.slice(from, from + BATCH_SIZE);
    const result = await judgeBatch(batch.map(l => l.url));
    reveal = reveal.then(() => show(from, result, batch.length));
  });
  await runPool(tasks, MAX_IN_FLIGHT);
  await reveal;
  await retryArchive(gen);
  if (gen !== scanGen) return;

  scanFailed = failed;
  finished = true;
  renderHeadline();
  live.textContent = statusEl.textContent;
  selectDefault();
  bell();
}

// ---------------------------------------------------------------------------
// Ask again
// ---------------------------------------------------------------------------

/** Swap one judgement for a fresh answer: plot, ledger row, tally, patch note and inscription. */
function applyReplacement(index: number, fresh: Judgement): void {
  const old = views[index];
  if (!old) return;
  const merged = mergeJudgement(judgements, index, fresh, excluded);
  judgements = merged.judgements;
  const full = judgements[index]!;
  const view = toGraveView(full, index);
  views[index] = view;

  const oldPlot = plotAt(index);
  const hadFocus = !!oldPlot && oldPlot.contains(document.activeElement);
  if (oldPlot) {
    const li = createPlot(view, 0);
    oldPlot.parentElement?.replaceWith(li);
    scheduleLayout();
  }
  const oldRow = Array.from(rowsEl.querySelectorAll<HTMLTableRowElement>('tr')).find(r => r.dataset['i'] === String(index));
  oldRow?.replaceWith(createRow(view));

  // roving tabindex and aria-pressed come back through select(); the inscription redraws if selected
  if (selected === index) select(index, hadFocus);
  else if (oldPlot) {
    const b = plotAt(index);
    if (b) b.tabIndex = oldPlot.tabIndex;
    if (b && hadFocus) b.focus();
  }
  renderTally();
  renderPatchNote();
}

function askAnnouncement(v: GraveView): string {
  return `${v.host} is now ${LABEL[v.verdict].toLowerCase()}. ${count()}.`;
}

async function askAgain(index: number): Promise<void> {
  const v = views[index];
  if (!v || asking.has(index)) return;
  const gen = scanGen;
  const buttonHadFocus = document.activeElement?.id === 'ask-again';
  asking.add(index);
  if (selected === index) renderInscription(v);
  live.textContent = `Asking the archive again about ${v.host}.`;
  const result = await judgeBatch([v.url]);
  if (gen !== scanGen) return;
  asking.delete(index);
  const fresh = result.ok ? result.judgements[0] : undefined;
  if (fresh) {
    applyReplacement(index, fresh);
    const now = views[index]!;
    live.textContent = askAnnouncement(now);
  } else {
    const detail = result.ok ? 'the server sent an unexpected reply' : result.detail;
    showError(`1 link could not be checked (${detail}). Its old answer stays.`);
    if (selected === index) renderInscription(views[index]);
  }
  if (buttonHadFocus && selected === index) {
    const btn = document.getElementById('ask-again');
    if (btn) btn.focus();
    else plotAt(index)?.focus();
  }
}

/** Once per scan: ask the archive again about every link whose lookup failed. */
async function retryArchive(gen: number): Promise<void> {
  const indexes = retryIndexes(judgements).filter(i => !asking.has(i));
  if (!indexes.length) return;
  statusEl.textContent = `Asking the archive again for ${indexes.length} ${plural(indexes.length, 'link', 'links')}.`;
  indexes.forEach(i => asking.add(i));
  if (selected >= 0 && asking.has(selected)) renderInscription(views[selected]);
  const tasks = chunk(indexes, BATCH_SIZE).map(batch => async (): Promise<void> => {
    const result = await judgeBatch(batch.map(i => views[i]!.url));
    if (gen !== scanGen) return;
    batch.forEach((i, n) => {
      asking.delete(i);
      const fresh = result.ok ? result.judgements[n] : undefined;
      if (fresh) applyReplacement(i, fresh);
    });
  });
  await runPool(tasks, MAX_IN_FLIGHT);
  if (gen !== scanGen) return;
  indexes.forEach(i => asking.delete(i));
  if (selected >= 0) renderInscription(views[selected]);
  live.textContent = `Asked the archive again for ${indexes.length} ${plural(indexes.length, 'link', 'links')}. ${count()}.`;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

function download(): void {
  const patched = patchedDocument(currentSource, judgements, excluded);
  const ext = currentKind === 'html' ? 'html' : 'md';
  const name = `revenant-patched.${ext}`;
  const blob = new Blob([patched], { type: currentKind === 'html' ? 'text/html' : 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  const n = patchCount();
  live.textContent = `${name} downloaded with ${n} ${plural(n, 'link', 'links')} pointing to archived copies.`;
}

// Copy patched document: the same text as Download. If the Clipboard API is missing or rejects, the
// text goes into a readonly textarea, selected, so Ctrl+C works. The textarea is removed again when it
// loses focus or on Escape (focus returns to the button), so focus is never trapped there.
let copyPatchedTimer = 0;
function copiedPatched(message: string, label: string): void {
  live.textContent = message;
  copyPatchedBtn.textContent = label;
  clearTimeout(copyPatchedTimer);
  copyPatchedTimer = window.setTimeout(() => { copyPatchedBtn.textContent = 'Copy patched document'; }, 2000);
}

function hidePatchedFallback(): void {
  patchedFallback.hidden = true;
  patchedFallback.value = '';
}
patchedFallback.addEventListener('blur', hidePatchedFallback);
patchedFallback.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  hidePatchedFallback();
  copyPatchedBtn.focus();
});

copyPatchedBtn.addEventListener('click', () => {
  if (copyPatchedBtn.disabled) return;
  const text = patchedDocument(currentSource, judgements, excluded);
  const message = copiedMessage(patchCount());
  const fallback = (): void => {
    patchedFallback.value = text;
    patchedFallback.hidden = false;
    patchedFallback.focus();
    patchedFallback.select();
    copiedPatched(COPY_FAILED_MESSAGE, 'Copy failed');
  };
  if (!navigator.clipboard) return fallback();
  navigator.clipboard.writeText(text).then(() => copiedPatched(message, message), fallback);
});

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------

function bell(): void {
  if (soundBtn.getAttribute('aria-pressed') !== 'true') return;
  const ac = new AudioContext();
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.frequency.value = 196;
  g.gain.setValueAtTime(.25, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(.001, ac.currentTime + 2.5);
  o.connect(g).connect(ac.destination);
  o.start();
  o.onended = () => { void ac.close(); };
  o.stop(ac.currentTime + 2.5);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// The hero form scans the address (Enter in the field submits it).
heroForm.addEventListener('submit', e => {
  e.preventDefault();
  if (scanning) return;
  if (!address.value.trim()) {
    showError(EMPTY_ERROR, true, 'address');
    address.focus();
    return;
  }
  void scan('address');
});

// The lower form scans the textarea and clears the address field.
$('doc').addEventListener('submit', e => {
  e.preventDefault();
  if (scanBtn.disabled) return;
  if (!source.value.trim()) {
    showError(EMPTY_ERROR, true, 'source');
    source.focus();
    return;
  }
  address.value = '';
  void scan('text');
});

sampleScanBtn.addEventListener('click', scanSample);

// Copy link: the address bar already holds this scan's link (writeAddress).
let copyTimer = 0;
function copied(message: string, label: string): void {
  live.textContent = message;
  copyBtn.textContent = label;
  clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2000);
}

copyBtn.addEventListener('click', () => {
  const href = location.href;
  const fallback = (): void => {
    copyFallback.value = href;
    copyFallback.hidden = false;
    copyFallback.focus();
    copyFallback.select();
    copied('Link selected. Press Ctrl+C to copy it.', 'Link selected');
  };
  if (!navigator.clipboard) return fallback();
  navigator.clipboard.writeText(href).then(() => copied('Link copied.', 'Link copied.'), fallback);
});

// A link with ?sample=1, ?repo= or ?url= scans on load. Invalid values show the error and do not scan.
{
  const param = parseScanParams(location.search);
  if (param.kind === 'sample') scanSample();
  else if (param.kind === 'repo' || param.kind === 'url') {
    address.value = param.value;
    void scan('address');
  } else if (param.kind === 'invalid') showError(param.message, false, 'address');
}

$('sample').addEventListener('click', () => {
  source.value = sample;
  clearError();
});

soundBtn.addEventListener('click', () => {
  const on = soundBtn.getAttribute('aria-pressed') !== 'true';
  soundBtn.setAttribute('aria-pressed', String(on));
  soundBtn.textContent = on ? 'Sound on' : 'Sound off';
});

const plotOf = (e: Event): HTMLButtonElement | null =>
  (e.target as HTMLElement).closest<HTMLButtonElement>('.plot');

yard.addEventListener('click', e => {
  const b = plotOf(e);
  if (b) select(Number(b.dataset['i']));
});
yard.addEventListener('focusin', e => {
  const b = plotOf(e);
  if (b && Number(b.dataset['i']) !== selected) select(Number(b.dataset['i']));
});
yard.addEventListener('keydown', e => {
  if (selected < 0) return;
  const step = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[e.key];
  if (step) {
    e.preventDefault();
    // document order among the plots that exist right now
    const order = present().map(v => v.index);
    const at = order.indexOf(selected);
    const to = order[Math.max(0, Math.min(order.length - 1, at + step))];
    if (to !== undefined) select(to, true);
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = views[selected];
    if (!v?.snap) return;
    // first Enter raises the link, the next one opens the archived page
    if (v.raised) window.open(v.snap, '_blank', 'noopener');
    else resurrect(selected);
  }
});

$('ins-action').addEventListener('click', e => {
  const id = (e.target as HTMLElement).id;
  if (id === 'resurrect') resurrect(selected, true);
  else if (id === 'ask-again') void askAgain(selected);
});
downloadBtn.addEventListener('click', download);
