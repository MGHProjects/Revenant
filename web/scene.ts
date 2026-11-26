/**
 * scene.ts: the graveyard's shapes, plots, moon, ghost and inscription.
 *
 * No top-level DOM access, so the pure helpers (lifespanHeight, toGraveView, ...) can be
 * imported by tests. Every builder creates DOM with createElement/textContent/setAttribute:
 * URLs, reasons and snapshot links are attacker-controlled and never reach innerHTML.
 * Only static SVG strings (no data) are parsed as markup.
 */

import type { EpitaphResult, Judgement, Verdict } from '../src/core/types.js';
import { archiveNote } from '../src/core/archive-note.js';
import { canAskAgain } from './ask-again.js';
import { hostParts } from './host-parts.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function yearOf(iso: string): number | undefined {
  const m = ISO_DATE.exec(iso);
  return m ? Number(m[1]) : undefined;
}

/** Pixel height of a tombstone: clamp(wholeYears(first, last) * 8, 64, 176); 64 with no dates. */
export function lifespanHeight(epitaph?: EpitaphResult): number {
  if (!epitaph || epitaph === 'none' || epitaph === 'unavailable') return 64;
  const first = yearOf(epitaph.first);
  const last = yearOf(epitaph.last);
  if (first === undefined || last === undefined) return 64;
  return Math.min(Math.max(Math.abs(last - first) * 8, 64), 176);
}

/** "2017-03-14" -> "14 Mar 2017". String arithmetic only: no Date, no locale. */
export function formatSeen(iso: string): string | undefined {
  const m = ISO_DATE.exec(iso);
  if (!m) return undefined;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return undefined;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** A snapshot link is only ever used as an href when it points at the Wayback Machine over https. */
export function safeSnapshot(url: string | undefined): string | undefined {
  return typeof url === 'string' && url.startsWith('https://web.archive.org/') ? url : undefined;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

export const LABEL: Record<Verdict, string> = {
  alive: 'Alive',
  dead: 'Dead',
  possessed: 'Possessed',
  restless: 'Restless',
};

/** What the scene needs to draw one link. */
export interface GraveView {
  index: number;
  url: string;
  host: string;
  verdict: Verdict;
  reason: string;
  first?: number;
  last?: number;
  seen?: string;
  snap?: string;
  /** archiveNote(): why a dead or possessed link has no archived copy. */
  note?: string;
  height: number;
  raised: boolean;
  /** The archive could not be reached for this link: its inscription offers Ask again. */
  archiveUnavailable?: true;
}

export function toGraveView(j: Judgement, index: number): GraveView {
  const view: GraveView = {
    index,
    url: j.link.url,
    host: hostOf(j.link.url),
    verdict: j.verdict,
    reason: j.reason,
    height: lifespanHeight(j.epitaph),
    raised: false,
  };
  const e = j.epitaph;
  if (e && e !== 'none' && e !== 'unavailable') {
    const first = yearOf(e.first);
    const last = yearOf(e.last);
    if (first !== undefined && last !== undefined) {
      view.first = first;
      view.last = last;
      const seen = formatSeen(e.copy);
      if (seen) view.seen = seen;
    }
  }
  const snap = safeSnapshot(j.resurrection);
  if (snap) view.snap = snap;
  const note = archiveNote(j);
  if (note) view.note = note;
  if (j.archiveUnavailable) view.archiveUnavailable = true;
  return view;
}

/** "2009 – 2017 · copy from 14 Mar 2016", or undefined when the link has no dates. */
export function epitaphText(v: GraveView): string | undefined {
  if (v.first === undefined || v.last === undefined) return undefined;
  return `${v.first} – ${v.last}${v.seen ? ` · copy from ${v.seen}` : ''}`;
}

/** What the "Archived copy" cell and the inscription say when there is no snapshot link. */
export function noSnapshotText(v: GraveView): string {
  if (v.verdict === 'alive' || v.verdict === 'restless') return 'Not needed';
  return v.note ?? 'No archived copy';
}

// ---------------------------------------------------------------------------
// Static SVG (no data interpolated)
// ---------------------------------------------------------------------------

const CHAPEL = '<svg width="72" height="104" viewBox="0 0 72 104" aria-hidden="true"><path d="M10 104V44L36 14l26 30v60Z" fill="#36415a"/><path class="lamp" d="M27 86V62a9 9 0 0 1 18 0v24Z" fill="#f2a541"/><rect x="35.25" y="53" width="1.5" height="33" fill="#36415a"/><rect x="27" y="68" width="18" height="1.5" fill="#36415a"/></svg>';
const HAND = '<svg class="hand" width="64" height="120" viewBox="0 0 64 120" aria-hidden="true" fill="#7dffb0"><rect x="22" y="66" width="20" height="54" rx="4"/><rect x="14" y="44" width="37" height="34" rx="10"/><rect x="14" y="14" width="8" height="40" rx="4"/><rect x="24" y="4" width="8" height="48" rx="4"/><rect x="34" y="8" width="8" height="44" rx="4"/><rect x="44" y="18" width="7" height="36" rx="3.5"/><rect x="10" y="52" width="9" height="24" rx="4.5" transform="rotate(-28 14.5 74)"/></svg>';
const GHOST = '<svg class="ghost" width="44" height="56" viewBox="0 0 44 56" aria-hidden="true"><path d="M4 56V22a18 18 0 0 1 36 0v34l-6-6-6 6-6-6-6 6-6-6Z" fill="#f1ecdd"/><circle cx="16" cy="24" r="2.5" fill="#0b0d12"/><circle cx="28" cy="24" r="2.5" fill="#0b0d12"/></svg>';

const CANDLE = '<svg class="candle" width="14" height="26" viewBox="0 0 14 26" aria-hidden="true"><rect x="4" y="12" width="6" height="14" rx="1" fill="#b8b4a6"/><path class="flame" d="M7 1c3 4 4 6 4 8a4 4 0 0 1-8 0c0-2 1-4 4-8Z" fill="#f2a541"/></svg>';

function fromStatic(markup: string): Element {
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstElementChild as Element;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------------------
// Shapes and plots
// ---------------------------------------------------------------------------

/** What a figure needs beyond its verdict: a stone's height and the years carved on it. */
export interface FigureOptions {
  height?: number;
  first?: number;
  last?: number;
}

/**
 * The `.figure` of one verdict: the single source of the chapel, stone, hand and fog shapes,
 * used by every plot and by the "What rises" section.
 */
export function buildFigure(verdict: Verdict, options: FigureOptions = {}): HTMLElement {
  const figure = el('span', 'figure');
  const riser = el('span', 'riser');
  riser.append(createShape(verdict, options));
  figure.append(riser);
  return figure;
}

function createShape(verdict: Verdict, o: FigureOptions): Node {
  switch (verdict) {
    case 'alive':
      return fromStatic(CHAPEL);
    case 'dead': {
      const stone = el('span', 'stone');
      stone.style.setProperty('--h', `${o.height ?? 64}px`);
      if (o.first !== undefined && o.last !== undefined) {
        stone.append(el('span', undefined, String(o.first)), el('span', 'rule'), el('span', undefined, String(o.last)));
      }
      return stone;
    }
    case 'possessed':
      return fromStatic(HAND);
    case 'restless': {
      const fog = el('span', 'fog');
      fog.setAttribute('aria-hidden', 'true');
      fog.append(el('span', 'f1'), el('span', 'f2'), el('span', 'f3'));
      return fog;
    }
  }
}

const plotLabel = (v: GraveView): string => LABEL[v.verdict] + (v.raised ? ', raised' : '');

/**
 * The host label: one inline-block span per part, a <wbr> after every dot except the last part.
 * Built from text nodes only (the host comes from an untrusted document). <wbr> adds no text,
 * so the accessible name and copy/paste hold the host exactly once.
 */
function hostLabel(host: string): HTMLElement {
  const label = el('span', 'host');
  const parts = hostParts(host);
  parts.forEach((part, i) => {
    const span = el('span', 'hpart');
    span.append(document.createTextNode(part));
    label.append(span);
    if (i < parts.length - 1) label.append(document.createElement('wbr'));
  });
  return label;
}

/** `delay` is the rise delay in ms: the link's position within its batch times 110. */
export function createPlot(v: GraveView, delay: number): HTMLLIElement {
  const li = el('li');
  const btn = el('button', `plot ${v.verdict}`);
  btn.type = 'button';
  btn.tabIndex = -1;
  btn.dataset['i'] = String(v.index);
  btn.setAttribute('aria-pressed', 'false');
  btn.style.setProperty('--d', `${delay}ms`);

  const figure = buildFigure(v.verdict, v);
  // A plot built again for a link that is already raised (Ask again) keeps its candle, lit at once.
  if (v.raised) addCandle(figure, v, false);

  btn.append(figure, hostLabel(v.host), el('span', 'verdict', plotLabel(v)));
  li.append(btn);
  return li;
}

/**
 * A candle at the foot of the figure, for as long as the link is raised. Only dead and possessed
 * links can be raised. `lighting` plays the `light` keyframes (styles.css); the caller adds it once the ghost has left.
 */
function addCandle(figure: Element, v: GraveView, lighting: boolean): void {
  if (v.verdict !== 'dead' && v.verdict !== 'possessed') return;
  if (figure.querySelector('.candle')) return;
  const candle = fromStatic(CANDLE);
  if (lighting) candle.classList.add('lighting');
  figure.append(candle);
}

/** Marks the plot raised, lights its candle and lets a pale ghost leave the grave for 1.3 s. */
export function raisePlot(plot: HTMLElement, v: GraveView, showGhost: boolean): void {
  const label = plot.querySelector('.verdict');
  if (label) label.textContent = plotLabel(v);
  const figure = plot.querySelector('.figure');
  if (!figure) return;
  if (!showGhost) {
    addCandle(figure, v, false);
    return;
  }
  figure.querySelector('.ghost')?.remove();
  const ghost = fromStatic(GHOST);
  figure.append(ghost);
  // The candle is lit when the ghost has left. A plot removed by a new scan, or a ghost replaced
  // by a later raise, gets nothing from this timer.
  setTimeout(() => {
    const present = ghost.isConnected && plot.isConnected;
    ghost.remove();
    if (present) addCandle(figure, v, true);
  }, 1300);
}

// ---------------------------------------------------------------------------
// Moon
// ---------------------------------------------------------------------------

/** p in [0, 1]: 0 is a new moon, 1 is full. The shade slides off the disc by 104 %; the glow's opacity is p. */
export function setMoon(p: number): void {
  const clamped = Math.min(Math.max(p, 0), 1);
  const moon = document.getElementById('moon');
  if (!moon) return;
  moon.style.setProperty('--shade', `${Math.round(clamped * 104)}%`);
  // The glow's opacity: the same progress, from one place.
  moon.closest<HTMLElement>('.sky')?.style.setProperty('--progress', clamped.toFixed(2));
  moon.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
}

// ---------------------------------------------------------------------------
// Inscription
// ---------------------------------------------------------------------------

function setText(id: string, text: string): void {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

/** Fills the inscription for `v`; returns the "Open the archived page" link when it was drawn. */
export function showInscription(v: GraveView | undefined): HTMLAnchorElement | undefined {
  const empty = document.getElementById('ins-empty');
  const body = document.getElementById('ins-body');
  const action = document.getElementById('ins-action');
  const tag = document.getElementById('ins-tag');
  const epitaph = document.getElementById('ins-epitaph');
  const note = document.getElementById('ins-note');
  if (!empty || !body || !action || !tag || !epitaph || !note) return undefined;
  empty.hidden = !!v;
  body.hidden = !v;
  if (!v) return undefined;

  tag.className = `tag ${v.verdict}`;
  tag.textContent = LABEL[v.verdict];
  setText('ins-host', v.host);
  setText('ins-url', v.url);
  setText('ins-why', v.reason);

  const text = v.snap ? epitaphText(v) : undefined;
  epitaph.hidden = !text;
  epitaph.textContent = text ?? '';
  const noteText = v.snap || (v.verdict !== 'dead' && v.verdict !== 'possessed') ? undefined : v.note;
  note.hidden = !noteText;
  note.textContent = noteText ?? '';

  action.replaceChildren();
  let link: HTMLAnchorElement | undefined;
  if (v.snap) link = drawSnapshotActions(action, v);
  if (canAskAgain(v)) {
    const ask = el('button', 'btn', 'Ask again');
    ask.type = 'button';
    ask.id = 'ask-again';
    action.append(ask);
  }
  return link;
}

function drawSnapshotActions(action: HTMLElement, v: GraveView): HTMLAnchorElement | undefined {
  if (!v.snap) return undefined;
  if (v.raised) {
    const a = el('a', 'btn go fade', 'Open the archived page');
    a.href = v.snap;
    a.target = '_blank';
    a.rel = 'noopener';
    const all = el('a', 'btn fade', 'See every capture');
    all.href = `https://web.archive.org/web/*/${encodeURI(v.url)}`;
    all.target = '_blank';
    all.rel = 'noopener';
    action.append(a, all);
    return a;
  }
  const b = el('button', 'btn go', 'Resurrect');
  b.type = 'button';
  b.id = 'resurrect';
  action.append(b);
  return undefined;
}
