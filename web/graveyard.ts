/**
 * graveyard.ts: the Revenant page. Extract, batching, state, ledger, download, sound, events.
 *
 * Extract runs in the browser; the Worker judges at most 3 URLs per request and the page keeps
 * at most 2 requests in flight (free-plan limits, see tech.md). All DOM is built with
 * textContent / setAttribute: nothing from a document or the network reaches innerHTML.
 */

import type { Judgement, Link, Verdict } from '../src/core/types.js';
import { extract } from '../src/core/extract.js';
import { patch } from '../src/core/patch.js';
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

const LINK_CAP = 200;
const BATCH_SIZE = 3;
const MAX_IN_FLIGHT = 2;
/** Minimum gap between two batches appearing, so a burst of replies still rises batch by batch. */
const REVEAL_GAP_MS = 900;
const EMPTY_ERROR = 'Paste a document or enter an address first.';

type Kind = 'markdown' | 'html';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const yard = $('yard');
const statusEl = $('status');
const live = $('live');
const source = $<HTMLTextAreaElement>('source');
const address = $<HTMLInputElement>('address');
const sourceError = $('source-error');
const scanBtn = $<HTMLButtonElement>('scan');
const downloadBtn = $<HTMLButtonElement>('download');
const soundBtn = $<HTMLButtonElement>('sound');
const rowsEl = $('rows');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Indexed by document position; holes while a later batch has returned before an earlier one. */
let views: Array<GraveView | undefined> = [];
let judgements: Array<Judgement | undefined> = [];
let selected = -1;
let currentSource = '';
let currentKind: Kind = 'markdown';
let scanning = false;
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

function renderTally(): void {
  const c = tallies();
  for (const k of Object.keys(c) as Verdict[]) $(`n-${k}`).textContent = String(c[k]);
}

// ---------------------------------------------------------------------------
// Plots
// ---------------------------------------------------------------------------

/** Insert at the link's document position, whatever order batches come back in. */
function addPlot(v: GraveView): void {
  views[v.index] = v;
  // rise delay: the link's position within its batch times 110 ms
  const li = createPlot(v, (v.index % BATCH_SIZE) * 110);
  const next = plotButtons().find(b => Number(b.dataset['i']) > v.index);
  if (next) yard.insertBefore(li, next.parentElement);
  else yard.append(li);
  if (selected < 0) {
    // roving tabindex: the first plot in document order is the tab stop until one is selected
    plotButtons().forEach((b, n) => { b.tabIndex = n === 0 ? 0 : -1; });
  }
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
  showInscription(v);
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

function showError(message: string, invalid = false): void {
  sourceError.textContent = message;
  sourceError.hidden = false;
  source.setAttribute('aria-invalid', String(invalid));
  live.textContent = message;
}

function clearError(): void {
  sourceError.hidden = true;
  sourceError.textContent = EMPTY_ERROR;
  source.setAttribute('aria-invalid', 'false');
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function looksLikeHtml(text: string): boolean {
  return /^\s*(<!doctype html|<[a-z][a-z0-9-]*(\s|>|\/>))/i.test(text);
}

const isRepoSlug = (s: string): boolean => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s);

async function resolveAddress(input: string): Promise<{ source: string; kind: Kind } | { error: string }> {
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
  let body: { source?: unknown; kind?: unknown; error?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch { /* handled below */ }
  if (!res.ok || typeof body.source !== 'string') {
    const detail = typeof body.error === 'string' ? body.error.replace(/\.$/, '') : `HTTP ${res.status}`;
    return { error: `Could not load that address: ${detail}.` };
  }
  return { source: body.source, kind: body.kind === 'html' ? 'html' : 'markdown' };
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
  views = [];
  judgements = [];
  selected = -1;
  excluded.clear();
  showInscription(undefined);
  $('ledger').hidden = true;
  rowsEl.replaceChildren();
  downloadBtn.disabled = true;
  setMoon(0);
  renderTally();
}

async function scan(): Promise<void> {
  scanBtn.disabled = true;
  scanning = true;
  clearError();
  resetScene();
  try {
    await runScan();
  } finally {
    scanning = false;
    scanBtn.disabled = false;
    renderPatchNote();
  }
}

async function runScan(): Promise<void> {
  const addr = address.value.trim();
  let text: string;
  let kind: Kind;
  if (addr) {
    statusEl.textContent = 'Fetching the document.';
    const resolved = await resolveAddress(addr);
    if ('error' in resolved) {
      statusEl.textContent = 'Paste a document. Its links rise here.';
      showError(resolved.error);
      return;
    }
    text = resolved.source;
    kind = resolved.kind;
  } else {
    text = source.value;
    kind = looksLikeHtml(text) ? 'html' : 'markdown';
  }
  currentSource = text;
  currentKind = kind;

  const found = extract(text, kind);
  if (found.length === 0) {
    statusEl.textContent = 'Paste a document. Its links rise here.';
    showError('No links found. Only http and https links are scanned.');
    return;
  }
  const links: Link[] = found.slice(0, LINK_CAP);
  const total = links.length;
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

  const judged = total - failed;
  statusEl.textContent = found.length > LINK_CAP
    ? `${judged} of ${found.length} links judged.${capNote}`
    : failed ? `${judged} of ${total} ${plural(total, 'link', 'links')} judged.` : `${total} ${plural(total, 'link', 'links')} judged.`;
  selectDefault();
  bell();
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

function download(): void {
  const list = judgements.filter((j): j is Judgement => j !== undefined);
  const patched = patch(currentSource, list, excluded);
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
  o.stop(ac.currentTime + 2.5);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

$('doc').addEventListener('submit', e => {
  e.preventDefault();
  if (scanBtn.disabled) return;
  const empty = !source.value.trim() && !address.value.trim();
  if (empty) {
    showError(EMPTY_ERROR, true);
    source.focus();
    return;
  }
  void scan();
});

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
  if ((e.target as HTMLElement).id === 'resurrect') resurrect(selected, true);
});
downloadBtn.addEventListener('click', download);
