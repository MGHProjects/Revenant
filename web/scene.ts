/**
 * scene.ts — SVG graveyard scene renderer for Revenant.
 *
 * Exports:
 *   renderScene(judgements, container)  — render one element per judgement
 *   advanceMoon(step, total)            — wax the moon SVG by one batch step
 *
 * Shapes:
 *   alive     → lit window (amber #f2a541)
 *   dead      → crumbling tombstone (bone/slate), height scaled to lifespan
 *   possessed → zombie hand with green glow (#7dffb0), height scaled to lifespan
 *   restless  → fog patch (pale slate)
 *
 * Each element:
 *   - class="grave" + data-verdict for CSS targeting
 *   - visible text label (colour is never the only signal)
 *   - title tooltip with full URL
 *   - tabindex="0" for keyboard navigation
 *   - 400–900 ms ease-out rise animation; suppressed by prefers-reduced-motion
 *   - epitaph shown on tombstone face (dead) and hand element (possessed)
 */

import type { Judgement, Epitaph } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Motion preference (checked once at module load; re-read per render would
// also be fine but adds no value since the page is not long-lived enough
// for the user to change OS settings mid-session without a reload).
// ---------------------------------------------------------------------------

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// Height formula
// ---------------------------------------------------------------------------

/**
 * Compute element height from epitaph lifespan.
 * clamp(lifespanYears * 12, 40, 220) px.
 * Uses 40 px minimum when no epitaph is present.
 */
function lifespanHeight(epitaph?: Epitaph | 'unavailable'): number {
  if (!epitaph || epitaph === 'unavailable') return 40;
  const y = Math.abs(
    new Date(epitaph.last).getFullYear() - new Date(epitaph.first).getFullYear()
  );
  return Math.min(Math.max(y * 12, 40), 220);
}

/** Format an epitaph for display on a grave element. */
function formatEpitaph(epitaph?: Epitaph | 'unavailable'): string {
  if (!epitaph || epitaph === 'unavailable') return '';
  // Show years only on the shape; full dates in the ledger
  const firstYear = new Date(epitaph.first).getFullYear();
  const lastYear  = new Date(epitaph.last).getFullYear();
  if (firstYear === lastYear) return String(firstYear);
  return `${firstYear} – ${lastYear}`;
}

// ---------------------------------------------------------------------------
// SVG shape builders
// ---------------------------------------------------------------------------

/**
 * Lit window for `alive`.
 * A rectangular frame with two amber-lit panes and a warm glow.
 * Fixed 80 × 100 px — alive links have no lifespan height.
 */
function buildAliveElement(judgement: Judgement): SVGSVGElement {
  const W = 72;
  const H = 96;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'grave-svg grave-svg--alive');

  // SMIL <animate> elements are not suppressed by CSS animation:none, so we
  // skip them entirely when the user prefers reduced motion.
  const flickerLeft  = prefersReducedMotion ? '' :
    `<animate attributeName="opacity" values="0.9;0.75;0.9" dur="3.1s" repeatCount="indefinite"/>`;
  const flickerRight = prefersReducedMotion ? '' :
    `<animate attributeName="opacity" values="0.85;0.95;0.85" dur="2.7s" repeatCount="indefinite"/>`;

  svg.innerHTML = `
    <!-- Wall panel -->
    <rect x="4" y="4" width="64" height="88" rx="4"
          fill="#1c2230" stroke="#e8e2d0" stroke-width="1.5" stroke-opacity="0.35"/>
    <!-- Left pane — lit -->
    <rect x="12" y="14" width="20" height="28" rx="3" fill="#f2a541" opacity="0.9">
      ${flickerLeft}
    </rect>
    <!-- Right pane — lit -->
    <rect x="40" y="14" width="20" height="28" rx="3" fill="#f2a541" opacity="0.85">
      ${flickerRight}
    </rect>
    <!-- Mullion cross on left pane -->
    <line x1="22" y1="14" x2="22" y2="42" stroke="#1c2230" stroke-width="1.5"/>
    <line x1="12" y1="28" x2="32" y2="28" stroke="#1c2230" stroke-width="1.5"/>
    <!-- Mullion cross on right pane -->
    <line x1="50" y1="14" x2="50" y2="42" stroke="#1c2230" stroke-width="1.5"/>
    <line x1="40" y1="28" x2="60" y2="28" stroke="#1c2230" stroke-width="1.5"/>
    <!-- Sill -->
    <rect x="8" y="42" width="56" height="4" rx="1" fill="#e8e2d0" opacity="0.25"/>
    <!-- Warm glow below window -->
    <ellipse cx="36" cy="96" rx="30" ry="6" fill="#f2a541" opacity="0.18"/>
    <!-- "alive" label bar -->
    <rect x="4" y="62" width="64" height="22" rx="0 0 4 4" fill="#f2a541" opacity="0.12"/>
    <text x="36" y="77" text-anchor="middle"
          font-family="system-ui, sans-serif" font-size="10" font-weight="600"
          fill="#f2a541" letter-spacing="1">alive</text>
  `;

  return svg;
}

/**
 * Crumbling tombstone for `dead`.
 * Height scales with lifespan. Epitaph carved on the face.
 */
function buildDeadElement(judgement: Judgement): SVGSVGElement {
  const h   = lifespanHeight(judgement.epitaph);
  const W   = 64;
  const H   = h + 16; // extra ground level
  const arcH = Math.round(W * 0.42); // how tall the rounded top is
  // Crumble chip positions (deterministic from URL hash to stay stable)
  const seed  = judgement.link.url.length % 7;
  const chips = [
    { x: 4 + seed, y: 8, w: 8, h: 5 },
    { x: W - 14 + (seed % 3), y: 12, w: 6, h: 4 },
    { x: 2, y: h * 0.4, w: 5, h: 7 },
  ];

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'grave-svg grave-svg--dead');

  const epitaphText = formatEpitaph(judgement.epitaph);
  // Split epitaph into two lines if it contains em-dash
  const [epy1, epy2] = epitaphText.includes('–')
    ? epitaphText.split('–').map(s => s.trim())
    : [epitaphText, ''];

  // Cross position (centred, upper third)
  const crossY   = arcH * 0.55;
  const crossSize = Math.min(16, h * 0.22);

  // Chip polygons as a clip/mask overlay to give crumbling feel
  const chipsHtml = chips.map(c =>
    `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="#0b0d12" />`
  ).join('\n');

  svg.innerHTML = `
    <!-- Stone body with rounded top -->
    <path d="
      M ${W / 2} 2
      Q ${W - 2} 2 ${W - 2} ${arcH}
      L ${W - 2} ${h}
      L 2 ${h}
      L 2 ${arcH}
      Q 2 2 ${W / 2} 2
      Z"
      fill="#1c2230" stroke="#e8e2d0" stroke-width="1.2" stroke-opacity="0.5"/>
    <!-- Stone texture grain lines -->
    <line x1="8"       y1="${h * 0.3}" x2="12"      y2="${h * 0.32}" stroke="#e8e2d0" stroke-width="0.5" opacity="0.2"/>
    <line x1="${W-14}" y1="${h * 0.5}" x2="${W-10}"  y2="${h * 0.52}" stroke="#e8e2d0" stroke-width="0.5" opacity="0.2"/>
    <line x1="6"       y1="${h * 0.65}" x2="10"     y2="${h * 0.67}" stroke="#e8e2d0" stroke-width="0.5" opacity="0.15"/>
    <!-- Cross -->
    <line x1="${W / 2}" y1="${crossY - crossSize}" x2="${W / 2}" y2="${crossY + crossSize}"
          stroke="#e8e2d0" stroke-width="2" stroke-opacity="0.65" stroke-linecap="round"/>
    <line x1="${W / 2 - crossSize * 0.7}" y1="${crossY}" x2="${W / 2 + crossSize * 0.7}" y2="${crossY}"
          stroke="#e8e2d0" stroke-width="2" stroke-opacity="0.65" stroke-linecap="round"/>
    <!-- Epitaph dates on stone face -->
    ${epy1 ? `<text x="${W / 2}" y="${h * 0.70}"
        text-anchor="middle"
        font-family="'UnifrakturMaguntia','Palatino Linotype',Palatino,serif"
        font-size="${Math.max(7, Math.min(10, h * 0.09))}"
        fill="#e8e2d0" opacity="0.7">${epy1}</text>` : ''}
    ${epy2 ? `<text x="${W / 2}" y="${h * 0.82}"
        text-anchor="middle"
        font-family="'UnifrakturMaguntia','Palatino Linotype',Palatino,serif"
        font-size="${Math.max(7, Math.min(10, h * 0.09))}"
        fill="#e8e2d0" opacity="0.7">${epy2}</text>` : ''}
    <!-- Crumble chips (cut-out effect) -->
    ${chipsHtml}
    <!-- Ground line -->
    <rect x="0" y="${h}" width="${W}" height="16" rx="0" fill="#1c2230" opacity="0.5"/>
    <line x1="0" y1="${h}" x2="${W}" y2="${h}" stroke="#e8e2d0" stroke-width="0.75" stroke-opacity="0.25"/>
    <!-- "dead" label -->
    <text x="${W / 2}" y="${h - 6}"
          text-anchor="middle"
          font-family="system-ui, sans-serif" font-size="9" font-weight="600"
          fill="#e8e2d0" opacity="0.5" letter-spacing="1">dead</text>
  `;

  return svg;
}

/**
 * Zombie hand rising from soil for `possessed`.
 * Height scales with lifespan. Epitaph shown on the wrist band.
 * Green ectoplasm glow.
 */
function buildPossessedElement(judgement: Judgement): SVGSVGElement {
  const h  = lifespanHeight(judgement.epitaph);
  const W  = 56;
  const H  = h + 20;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'grave-svg grave-svg--possessed');

  const epitaphText = formatEpitaph(judgement.epitaph);

  // Wrist band y position (near bottom of the hand area)
  const bandY = h * 0.78;

  // Palm base, fingers emerge from soil; more fingers visible as height increases
  // Three fingers always; pinky adds at h > 80; thumb at h > 60
  const showPinky  = h > 80;
  const showThumb  = h > 60;
  const palmTop    = h * 0.18;
  const palmBottom = h * 0.82;
  const palmLeft   = W * 0.28;
  const palmRight  = W * 0.72;
  const palmMid    = W * 0.5;

  svg.innerHTML = `
    <defs>
      <!-- Ectoplasm glow filter -->
      <filter id="ecto-glow-${W}" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="blur"/>
        <feColorMatrix type="matrix"
          values="0 0 0 0 0.49
                  0 0 0 0 1
                  0 0 0 0 0.69
                  0 0 0 0.6 0" result="glow"/>
        <feMerge>
          <feMergeNode in="glow"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>

    <!-- Glow halo behind hand -->
    <ellipse cx="${palmMid}" cy="${palmTop + (palmBottom - palmTop) * 0.4}"
             rx="${(palmRight - palmLeft) * 0.9}" ry="${(palmBottom - palmTop) * 0.55}"
             fill="#7dffb0" opacity="0.08"/>

    <!-- Palm -->
    <path d="
      M ${palmLeft} ${palmBottom}
      Q ${palmLeft - 4} ${(palmTop + palmBottom) / 2} ${palmLeft + 2} ${palmTop + 10}
      Q ${palmMid - 6} ${palmTop - 4} ${palmMid} ${palmTop - 2}
      Q ${palmMid + 6} ${palmTop - 4} ${palmRight - 2} ${palmTop + 10}
      Q ${palmRight + 4} ${(palmTop + palmBottom) / 2} ${palmRight} ${palmBottom}
      Z"
      fill="#2a3820" stroke="#7dffb0" stroke-width="1.2" stroke-opacity="0.75"
      filter="url(#ecto-glow-${W})"/>

    <!-- Fingers -->
    <!-- Index finger -->
    <path d="M ${palmMid - 8} ${palmTop + 8}
             Q ${palmMid - 10} ${palmTop - 10} ${palmMid - 7} ${palmTop - 18}
             Q ${palmMid - 4} ${palmTop - 22} ${palmMid - 2} ${palmTop - 18}
             Q ${palmMid - 0} ${palmTop - 10} ${palmMid - 1} ${palmTop + 6}"
          fill="#2a3820" stroke="#7dffb0" stroke-width="1" stroke-opacity="0.65"/>
    <!-- Middle finger (tallest) -->
    <path d="M ${palmMid - 1} ${palmTop + 4}
             Q ${palmMid - 1} ${palmTop - 16} ${palmMid} ${palmTop - 24}
             Q ${palmMid + 2} ${palmTop - 28} ${palmMid + 4} ${palmTop - 23}
             Q ${palmMid + 5} ${palmTop - 15} ${palmMid + 4} ${palmTop + 3}"
          fill="#2a3820" stroke="#7dffb0" stroke-width="1" stroke-opacity="0.65"/>
    <!-- Ring finger -->
    <path d="M ${palmMid + 5} ${palmTop + 7}
             Q ${palmMid + 7} ${palmTop - 10} ${palmMid + 10} ${palmTop - 18}
             Q ${palmMid + 12} ${palmTop - 22} ${palmMid + 14} ${palmTop - 17}
             Q ${palmMid + 15} ${palmTop - 10} ${palmMid + 13} ${palmTop + 7}"
          fill="#2a3820" stroke="#7dffb0" stroke-width="1" stroke-opacity="0.65"/>

    ${showThumb ? `
    <!-- Thumb -->
    <path d="M ${palmLeft + 2} ${palmTop + 20}
             Q ${palmLeft - 6} ${palmTop + 12} ${palmLeft - 5} ${palmTop + 4}
             Q ${palmLeft - 4} ${palmTop} ${palmLeft} ${palmTop + 2}
             Q ${palmLeft + 4} ${palmTop + 8} ${palmLeft + 5} ${palmTop + 18}"
          fill="#2a3820" stroke="#7dffb0" stroke-width="1" stroke-opacity="0.55"/>
    ` : ''}

    ${showPinky ? `
    <!-- Pinky -->
    <path d="M ${palmRight - 2} ${palmTop + 10}
             Q ${palmRight + 2} ${palmTop} ${palmRight + 3} ${palmTop - 6}
             Q ${palmRight + 4} ${palmTop - 10} ${palmRight + 6} ${palmTop - 6}
             Q ${palmRight + 7} ${palmTop} ${palmRight + 5} ${palmTop + 10}"
          fill="#2a3820" stroke="#7dffb0" stroke-width="1" stroke-opacity="0.55"/>
    ` : ''}

    <!-- Knuckle lines on middle finger -->
    <line x1="${palmMid}" y1="${palmTop - 8}" x2="${palmMid + 3}" y2="${palmTop - 8}"
          stroke="#7dffb0" stroke-width="0.6" opacity="0.4"/>
    <line x1="${palmMid}" y1="${palmTop - 15}" x2="${palmMid + 3}" y2="${palmTop - 15}"
          stroke="#7dffb0" stroke-width="0.6" opacity="0.3"/>

    <!-- Wrist / torn sleeve band -->
    <rect x="${palmLeft - 2}" y="${bandY}" width="${palmRight - palmLeft + 4}" height="${Math.max(10, h * 0.1)}"
          rx="2" fill="#1c2230" stroke="#7dffb0" stroke-width="0.75" stroke-opacity="0.5"/>
    ${epitaphText ? `
    <text x="${palmMid}" y="${bandY + Math.max(10, h * 0.1) * 0.72}"
          text-anchor="middle"
          font-family="'UnifrakturMaguntia','Palatino Linotype',Palatino,serif"
          font-size="${Math.max(6, Math.min(9, h * 0.08))}"
          fill="#7dffb0" opacity="0.85">${epitaphText}</text>
    ` : ''}

    <!-- Ground / soil -->
    <rect x="0" y="${h}" width="${W}" height="20" rx="0" fill="#1c2230" opacity="0.6"/>
    <line x1="0" y1="${h}" x2="${W}" y2="${h}"
          stroke="#7dffb0" stroke-width="0.75" stroke-opacity="0.3"/>
    <!-- Soil cracks -->
    <path d="M ${palmLeft - 2} ${h} l -4 10 m 0 0 l -3 5" stroke="#7dffb0" stroke-width="0.5" opacity="0.2"/>
    <path d="M ${palmRight + 2} ${h} l 3 8" stroke="#7dffb0" stroke-width="0.5" opacity="0.2"/>

    <!-- "possessed" label -->
    <text x="${palmMid}" y="${h - 5}"
          text-anchor="middle"
          font-family="system-ui, sans-serif" font-size="8" font-weight="600"
          fill="#7dffb0" opacity="0.65" letter-spacing="0.5">possessed</text>
  `;

  return svg;
}

/**
 * Drifting fog patch for `restless`.
 * Fixed size; animated drift suppressed by prefers-reduced-motion.
 */
function buildRestlessElement(): SVGSVGElement {
  const W = 72;
  const H = 56;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'grave-svg grave-svg--restless');

  // SMIL <animateTransform> is not affected by CSS animation:none, so skip
  // the drift animations entirely when the user prefers reduced motion.
  const drift1 = prefersReducedMotion ? '' :
    `<animateTransform attributeName="transform" type="translate"
      values="0,0; 3,0; 0,0" dur="4.3s" repeatCount="indefinite"/>`;
  const drift2 = prefersReducedMotion ? '' :
    `<animateTransform attributeName="transform" type="translate"
      values="0,0; -4,0; 0,0" dur="5.1s" repeatCount="indefinite"/>`;
  const drift3 = prefersReducedMotion ? '' :
    `<animateTransform attributeName="transform" type="translate"
      values="0,0; 2,0; 0,0" dur="3.7s" repeatCount="indefinite"/>`;
  const drift4 = prefersReducedMotion ? '' :
    `<animateTransform attributeName="transform" type="translate"
      values="0,0; 2,1; 0,0" dur="6s" repeatCount="indefinite"/>`;
  const drift5 = prefersReducedMotion ? '' :
    `<animateTransform attributeName="transform" type="translate"
      values="0,0; -3,-1; 0,0" dur="4.8s" repeatCount="indefinite"/>`;

  svg.innerHTML = `
    <!-- Fog layers — three overlapping wisps -->
    <ellipse cx="36" cy="22" rx="28" ry="10" fill="#8899aa" opacity="0.18">
      ${drift1}
    </ellipse>
    <ellipse cx="30" cy="30" rx="24" ry="8" fill="#8899aa" opacity="0.22">
      ${drift2}
    </ellipse>
    <ellipse cx="40" cy="38" rx="20" ry="7" fill="#8899aa" opacity="0.16">
      ${drift3}
    </ellipse>
    <!-- Wisp tendrils -->
    <path d="M 10 28 Q 20 20 30 24 Q 40 28 50 20 Q 58 14 65 20"
          stroke="#8899aa" stroke-width="1.2" fill="none" opacity="0.3"
          stroke-linecap="round">
      ${drift4}
    </path>
    <path d="M 5 36 Q 18 28 28 33 Q 42 38 55 30 Q 62 26 70 32"
          stroke="#8899aa" stroke-width="1" fill="none" opacity="0.25"
          stroke-linecap="round">
      ${drift5}
    </path>
    <!-- "restless" label -->
    <text x="36" y="52"
          text-anchor="middle"
          font-family="system-ui, sans-serif" font-size="9" font-weight="600"
          fill="#8899aa" letter-spacing="0.5">restless</text>
  `;

  return svg;
}

// ---------------------------------------------------------------------------
// Grave wrapper element
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the outer `.grave` div that holds the SVG shape plus URL label.
 * Applies the staggered rise animation delay (100 ms per extra item in
 * the same batch, capped at 500 ms) so graves don't all pop at once.
 */
function buildGraveWrapper(judgement: Judgement, positionInBatch: number): HTMLElement {
  const { verdict, link, epitaph, resurrection } = judgement;

  const wrapper = document.createElement('div');
  wrapper.className = 'grave';
  wrapper.dataset['verdict'] = verdict;
  wrapper.setAttribute('tabindex', '0');

  // Stagger animation: 400 ms base + up to 500 ms offset
  const delayMs = Math.min(positionInBatch * 120, 500);
  wrapper.style.animationDelay = `${delayMs}ms`;

  // Accessible label: verdict + truncated URL
  const shortUrl = link.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const epitaphStr = epitaph && epitaph !== 'unavailable'
    ? ` · ${epitaph.first} to ${epitaph.last}`
    : '';
  wrapper.setAttribute('aria-label', `${verdict}: ${link.url}${epitaphStr}`);

  // Tooltip on the outer element
  wrapper.title = link.url;

  // Build the SVG shape
  let svgEl: SVGSVGElement;
  switch (verdict) {
    case 'alive':     svgEl = buildAliveElement(judgement);     break;
    case 'dead':      svgEl = buildDeadElement(judgement);      break;
    case 'possessed': svgEl = buildPossessedElement(judgement); break;
    case 'restless':  svgEl = buildRestlessElement();           break;
  }

  // Screen-reader description (supplementary to aria-label)
  const desc = document.createElementNS('http://www.w3.org/2000/svg', 'desc');
  desc.textContent = `${verdict} link: ${link.url}`;
  svgEl.prepend(desc);

  wrapper.appendChild(svgEl);

  // URL label below the shape
  const label = document.createElement('span');
  label.className = 'grave-label';
  label.textContent = shortUrl;
  label.title = link.url;
  wrapper.appendChild(label);

  // Resurrect button for dead/possessed links with a snapshot
  if (verdict === 'dead' || verdict === 'possessed') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'grave-resurrect';

    if (resurrection) {
      btn.textContent = 'Resurrect';
      btn.setAttribute('aria-label', `Resurrect ${shortUrl} — open archived version`);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.open(resurrection, '_blank', 'noopener,noreferrer');
      });
    } else {
      btn.textContent = 'No archive';
      btn.setAttribute('aria-label', `No archived version available for ${shortUrl}`);
      btn.disabled = true;
    }

    wrapper.appendChild(btn);
  }

  // Keyboard activation: Enter/Space opens resurrection or original URL
  wrapper.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const target = resurrection ?? link.url;
      window.open(target, '_blank', 'noopener,noreferrer');
    }
  });

  // Click on the wrapper itself (not the button) also navigates
  wrapper.addEventListener('click', (e) => {
    // Only if the click was directly on the wrapper, not on the button
    if ((e.target as HTMLElement).closest('.grave-resurrect')) return;
    const target = resurrection ?? link.url;
    window.open(target, '_blank', 'noopener,noreferrer');
  });

  return wrapper;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render every judgement in `judgements` into `container` as a grave element.
 * Clears the container first.
 */
export function renderScene(judgements: Judgement[], container: HTMLElement): void {
  container.innerHTML = '';
  judgements.forEach((j, i) => {
    container.appendChild(buildGraveWrapper(j, i));
  });
}

/**
 * Append one judgement to the scene without clearing it.
 * `positionInBatch` is the 0-based index within the current batch
 * (used to stagger the rise animation).
 */
export function appendGrave(
  judgement: Judgement,
  container: HTMLElement,
  positionInBatch: number
): void {
  container.appendChild(buildGraveWrapper(judgement, positionInBatch));
}

/**
 * Advance the moon SVG (id="moon-lit") one step toward full.
 * `step` is the 1-based batch number; `total` is the total batch count.
 * When step >= total the moon becomes fully lit.
 */
export function advanceMoon(step: number, total: number): void {
  const moonLit = document.getElementById('moon-lit') as SVGPathElement | null;
  if (!moonLit) return;

  const progress = total > 0 ? Math.min(step / total, 1) : 0;

  if (progress >= 1) {
    moonLit.setAttribute('d', 'M30 2 A28 28 0 1 1 30 58 A28 28 0 1 1 30 2 Z');
    return;
  }
  if (progress <= 0) {
    moonLit.setAttribute('d', 'M30 2 A28 28 0 0 1 30 2 Z');
    return;
  }

  // Wax from right to left across the moon face.
  const r  = 28;
  const cx = 30;
  const cy = 30;
  const x  = cx + r * (1 - 2 * progress);
  const h  = Math.sqrt(Math.max(0, r * r - (x - cx) * (x - cx)));
  const y1 = cy - h;
  const y2 = cy + h;
  const largeArc  = progress > 0.5 ? 1 : 0;
  const sweepFlag = progress > 0.5 ? 1 : 0;

  void y1; // used implicitly via the arc endpoints below

  const d = [
    `M ${cx} ${cy - r}`,
    `A ${r} ${r} 0 1 1 ${cx} ${cy + r}`,
    `A ${r} ${r} 0 ${largeArc} ${sweepFlag} ${cx} ${cy - r}`,
  ].join(' ');

  moonLit.setAttribute('d', d);
}

// ---------------------------------------------------------------------------
// Scene-specific CSS injected once at module load
// ---------------------------------------------------------------------------

(function injectSceneStyles(): void {
  if (document.getElementById('scene-ts-styles')) return;
  const style = document.createElement('style');
  style.id = 'scene-ts-styles';
  style.textContent = `
    /* Grave SVG containers */
    .grave-svg {
      display: block;
      overflow: visible;
    }

    /* Alive: amber glow on the window SVG */
    .grave-svg--alive {
      filter: drop-shadow(0 0 8px rgba(242, 165, 65, 0.45));
    }

    /* Dead: subtle desaturated shadow */
    .grave-svg--dead {
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.6));
    }

    /* Possessed: green ectoplasm glow */
    .grave-svg--possessed {
      filter: drop-shadow(0 0 10px rgba(125, 255, 176, 0.5));
    }

    /* Restless: faded */
    .grave-svg--restless {
      opacity: 0.75;
    }

    /* Resurrect button on dead/possessed graves */
    .grave-resurrect {
      display: block;
      margin-top: 4px;
      padding: 2px 8px;
      background: transparent;
      border: 1px solid currentColor;
      border-radius: 999px;
      font-family: system-ui, sans-serif;
      font-size: 0.65rem;
      font-weight: 600;
      letter-spacing: 0.06em;
      cursor: pointer;
      text-transform: uppercase;
      transition: background-color 200ms ease, color 200ms ease;
      white-space: nowrap;
    }

    .grave[data-verdict="dead"] .grave-resurrect {
      color: var(--bone, #e8e2d0);
      border-color: rgba(232, 226, 208, 0.4);
    }
    .grave[data-verdict="dead"] .grave-resurrect:hover:not(:disabled) {
      background: rgba(232, 226, 208, 0.12);
    }

    .grave[data-verdict="possessed"] .grave-resurrect {
      color: var(--ecto, #7dffb0);
      border-color: rgba(125, 255, 176, 0.5);
    }
    .grave[data-verdict="possessed"] .grave-resurrect:hover:not(:disabled) {
      background: rgba(125, 255, 176, 0.1);
    }

    .grave-resurrect:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    .grave-resurrect:focus-visible {
      outline: 2px solid var(--amber, #f2a541);
      outline-offset: 2px;
    }

    /* Rise animation for grave entries */
    @keyframes rise {
      from {
        transform: translateY(60px);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }

    .grave {
      animation: rise 700ms cubic-bezier(0.16, 1, 0.3, 1) both;
    }

    /* Suppress all animation when user prefers reduced motion */
    @media (prefers-reduced-motion: reduce) {
      .grave {
        animation: none !important;
      }
      .grave-svg--restless {
        animation: none !important;
      }
      .grave-svg svg * {
        animation: none !important;
      }
    }
  `;
  document.head.appendChild(style);
})();
