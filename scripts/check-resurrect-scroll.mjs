// Browser check for task 20.1: Resurrect and Ask again must not scroll the page.
//
// Usage:   node scripts/check-resurrect-scroll.mjs <port> [shotsDir]
//   <port>     port of a running dev server (`npm run dev`, Vite serves the page, normally 5173)
//   [shotsDir] optional folder; saves a PNG 300 ms after Resurrect (button click) per viewport
//
// Starts nothing except a headless Edge (Chromium also works: set EDGE=<path>). Uses only Node
// built-ins; talks to Edge through the DevTools protocol (global WebSocket, Node 22+).
// For each viewport (1440x1080, 1366x768, 1024x768) it loads /?sample=1 and waits for the scan:
//   1. selects a dead plot, records scrollY, clicks Resurrect, waits 400 ms: scrollY unchanged (±1 px)
//   2. same, but presses Enter on the focused plot instead of clicking the button
//   3. selects a restless plot, clicks Ask again, waits for it to finish: scrollY unchanged (±1 px)
// and 300 ms after Resurrect the ghost's bounding box must lie inside the viewport.
// Exit code 0 when all pass, 1 on any failure. The sample uses the live Wayback Machine, so a run
// needs network access and takes a minute or so.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.argv[2]);
const shots = process.argv[3];
if (!port) { console.error('usage: node scripts/check-resurrect-scroll.mjs <port> [shotsDir]'); process.exit(1); }

const EDGE = [
  process.env.EDGE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
if (!EDGE) { console.error('Edge not found; set EDGE=<path to msedge or chromium>'); process.exit(1); }

const VIEWPORTS = [[1440, 1080], [1366, 768], [1024, 768]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'revenant-scroll-'));
const debugPort = 9300 + Math.floor(Math.random() * 500);
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });

function cleanup() {
  try { edge.kill(); } catch { /* already gone */ }
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked; ignore */ } }, 500);
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      return ws;
    } catch { await sleep(250); }
  }
  throw new Error('could not reach Edge DevTools');
}

const ws = await connect();
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result);
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const cdp = (method, params) => send(method, params, sessionId);
// keep the tab "visible and focused" so requestAnimationFrame and ResizeObserver run on schedule
await cdp('Page.bringToFront');
await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
async function ev(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
  return r.result.value;
}
async function waitFor(expression, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ev(expression)) return; await sleep(200); }
  throw new Error(`timed out waiting for ${what}`);
}

let failures = 0;
const report = (ok, text) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`); if (!ok) failures++; };

async function load(w, h) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://localhost:${port}/?sample=1` });
  // scan finished: the address form is back and the inscription band is showing
  await waitFor(`!!document.querySelector('.plot') && !document.getElementById('hero-form').hidden && !document.getElementById('inscription').hidden`, 90000, 'the sample scan');
  await sleep(1500);
}

/** Selects a plot of the given verdict without scrolling the page; returns false when none exists. */
async function choose(selector) {
  const ok = await ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return false; b.click(); return true; })()`);
  if (ok) await sleep(700);
  return ok;
}

async function resurrectCase(w, h, how) {
  const tag = `${w}x${h} Resurrect by ${how}`;
  await load(w, h);
  // a dead plot that has a copy to raise: select it, then look for the Resurrect button
  const idx = await ev(`(() => { const l = [...document.querySelectorAll('.plot.dead')]; return l.map(b => b.dataset.i); })()`);
  let found = false;
  for (const i of idx) {
    await ev(`document.querySelector('.plot[data-i="${i}"]').click()`);
    await sleep(500);
    if (await ev(`!!document.getElementById('resurrect')`)) { found = true; break; }
  }
  if (!found) { report(false, `${tag}: no dead plot with a Resurrect button`); return; }
  const i = await ev(`document.querySelector('.plot[aria-pressed="true"]').dataset.i`);
  const before = await ev('window.scrollY');
  if (process.env.DEBUG_SCROLL) console.log(await ev(`Promise.race([new Promise(r => requestAnimationFrame(() => r('raf ok'))), new Promise(r => setTimeout(() => r('raf stalled'), 1500))])`), await ev(`document.visibilityState + ' ' + document.hasFocus()`));
  if (process.env.DEBUG_SCROLL) console.log(await ev(`(() => { const p = document.querySelector('.plot[aria-pressed="true"]').getBoundingClientRect(); const b = document.getElementById('inscription').getBoundingClientRect(); return JSON.stringify({ plotTop: p.top, plotBottom: p.bottom, bandTop: b.top, bandH: b.height, insH: document.documentElement.style.getPropertyValue('--ins-h'), docH: document.documentElement.scrollHeight }); })()`));
  if (how === 'button') {
    await ev(`document.getElementById('resurrect').click()`);
  } else {
    await ev(`document.querySelector('.plot[data-i="${i}"]').focus({ preventScroll: true })`);
    await sleep(100);
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }
  await sleep(300);
  const ghost = await ev(`(() => { const g = document.querySelector('.plot[data-i="${i}"] .ghost'); if (!g) return null; const r = g.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: innerWidth, vh: innerHeight }; })()`);
  if (shots && how === 'button') {
    mkdirSync(shots, { recursive: true });
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shots, `resurrect-${w}x${h}.png`), Buffer.from(data, 'base64'));
  }
  await sleep(100);
  const after = await ev('window.scrollY');
  report(Math.abs(after - before) <= 1, `${tag}: scrollY ${before} -> ${after}`);
  if (!ghost) report(false, `${tag}: no ghost at 300 ms`);
  else {
    const inside = ghost.top >= 0 && ghost.left >= 0 && ghost.bottom <= ghost.vh && ghost.right <= ghost.vw;
    report(inside, `${tag}: ghost box top ${Math.round(ghost.top)} bottom ${Math.round(ghost.bottom)} of viewport ${ghost.vh}`);
  }
}

async function askCase(w, h) {
  const tag = `${w}x${h} Ask again`;
  await load(w, h);
  if (!(await choose('.plot.restless'))) { report(false, `${tag}: the sample has no restless plot`); return; }
  if (!(await ev(`!!document.getElementById('ask-again')`))) { report(false, `${tag}: no Ask again button`); return; }
  const before = await ev('window.scrollY');
  await ev(`document.getElementById('ask-again').focus({ preventScroll: true })`);
  await ev(`document.getElementById('ask-again').click()`);
  await sleep(400);
  await waitFor(`(() => { const b = document.getElementById('ask-again'); return !b || !b.disabled; })()`, 60000, 'Ask again to finish');
  await sleep(400);
  const after = await ev('window.scrollY');
  report(Math.abs(after - before) <= 1, `${tag}: scrollY ${before} -> ${after}`);
}

try {
  for (const [w, h] of VIEWPORTS) {
    await resurrectCase(w, h, 'button');
    await resurrectCase(w, h, 'Enter');
    await askCase(w, h);
  }
} catch (err) {
  report(false, `error: ${err.message}`);
} finally {
  ws.close();
  cleanup();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
