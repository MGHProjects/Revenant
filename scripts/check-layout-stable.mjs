// Browser check for task 20.2: the yard must not move when a scan ends.
//
// Usage:   node scripts/check-layout-stable.mjs <port> [shotsDir]
//   <port>     port of a running dev server (`npm run dev`, Vite serves the page, normally 5173)
//   [shotsDir] optional folder; saves empty / during / after PNGs per viewport
//
// Starts nothing except a headless Edge (Chromium also works: set EDGE=<path>). Node built-ins only.
// For 1440x900 and 375x812 it loads the page empty, clicks "Scan the sample" and measures the yard's
// top (getBoundingClientRect().top + scrollY) in five states:
//   empty | right after the click | after the first batch | after the scan | after Ask again
// Asserts: top after the first batch == top after the scan (+-1 px); the hero's address field and
// both buttons are disabled during the scan and enabled afterwards. Other transitions are reported.
// Exit code 0 when all pass, 1 on any failure. The sample uses the live Wayback Machine.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.argv[2]);
const shots = process.argv[3];
if (!port) { console.error('usage: node scripts/check-layout-stable.mjs <port> [shotsDir]'); process.exit(1); }

const EDGE = [
  process.env.EDGE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
if (!EDGE) { console.error('Edge not found; set EDGE=<path to msedge or chromium>'); process.exit(1); }

const VIEWPORTS = [[1440, 900], [375, 812]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'revenant-layout-'));
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
await cdp('Page.bringToFront');
await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
async function ev(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
  return r.result.value;
}
async function waitFor(expression, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ev(expression)) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}
/** Waits `ms` while asking for animation frames (headless Edge idles without them). */
async function settle(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) await ev('new Promise((r) => requestAnimationFrame(() => r(1)))');
}

let failures = 0;
const report = (ok, text) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`); if (!ok) failures++; };

// Heights of the hero blocks, to say which one moved the yard.
const heroBlocks = () => ev(`['status', 'intro', 'copy-link', 'tally', 'hero-form', 'try'].map((id) => { const e = document.getElementById(id); return id + '=' + (e.hidden || !e.offsetParent ? 'hidden' : Math.round(e.getBoundingClientRect().height)); }).join(' ')`);
const yardTop = () => ev(`Math.round((document.getElementById('yard').getBoundingClientRect().top + scrollY) * 10) / 10`);
// The hero's controls: true when every one is disabled (or the whole form is hidden: the old behaviour).
const heroState = () => ev(`(() => {
  const ids = ['address', 'scan-address', 'scan-sample'];
  const els = ids.map((i) => document.getElementById(i));
  return { disabled: els.map((e) => e.disabled), formHidden: document.getElementById('hero-form').hidden };
})()`);
// A scan is running while the hero's address field is disabled or its form is hidden (old code).
const SCANNING = `(document.getElementById('address').disabled || document.getElementById('hero-form').hidden)`;
const DONE = `!${SCANNING} && !!document.querySelector('.plot') && !document.getElementById('inscription').hidden`;

async function shot(w, h, name) {
  if (!shots || w !== 1440) return;
  mkdirSync(shots, { recursive: true });
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, `${name}-${w}x${h}.png`), Buffer.from(data, 'base64'));
}

async function run(w, h) {
  const tag = `${w}x${h}`;
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  await cdp('Page.navigate', { url: `http://localhost:${port}/` });
  await waitFor(`!!document.getElementById('scan-sample')`, 30000, 'the page');
  await settle(1800); // let the scenery assemble
  const empty = await yardTop();
  await shot(w, h, 'before');

  await ev(`document.getElementById('scan-sample').click()`);
  await settle(50);
  const start = await yardTop();
  const during = await heroState();
  report(during.formHidden === false && during.disabled.every(Boolean), `${tag}: hero controls disabled during the scan, form not hidden (${JSON.stringify(during)})`);

  await waitFor(`document.querySelectorAll('.plot').length > 0`, 90000, 'the first plot');
  await settle(700);
  const stillScanning = await ev(SCANNING);
  const first = await yardTop();
  console.log(`HERO  ${tag} first batch: ${await heroBlocks()}`);
  const mid = await heroState();
  await shot(w, h, 'during');
  if (stillScanning) report(mid.formHidden === false && mid.disabled.every(Boolean), `${tag}: hero controls still disabled after the first batch`);
  else console.log(`NOTE  ${tag}: the scan had already finished when the first batch was measured`);

  await waitFor(DONE, 120000, 'the scan to finish');
  await settle(900);
  const end = await yardTop();
  console.log(`HERO  ${tag} after scan:   ${await heroBlocks()}`);
  const after = await heroState();
  await shot(w, h, 'after');
  report(after.formHidden === false && after.disabled.every((d) => !d), `${tag}: hero controls enabled after the scan (${JSON.stringify(after)})`);
  report(Math.abs(first - end) <= 1, `${tag}: yard top after first batch ${first} vs after scan ${end}`);

  // Ask again on a restless plot
  let ask = null;
  if (await ev(`(() => { const b = document.querySelector('.plot.restless'); if (!b) return false; b.click(); return true; })()`)) {
    await settle(600);
    if (await ev(`!!document.getElementById('ask-again')`)) {
      await ev(`document.getElementById('ask-again').click()`);
      await settle(400);
      await waitFor(`(() => { const b = document.getElementById('ask-again'); return !b || !b.disabled; })()`, 60000, 'Ask again to finish');
      await settle(900);
      ask = await yardTop();
    }
  }
  if (ask === null) report(false, `${tag}: no restless plot with an Ask again button`);

  console.log(`TOPS  ${tag}: empty ${empty} | after click ${start} | after first batch ${first} | after scan ${end} | after Ask again ${ask}`);
  console.log(`MOVES ${tag}: start ${Math.round((start - empty) * 10) / 10}, first batch ${Math.round((first - start) * 10) / 10}, end ${Math.round((end - first) * 10) / 10}, ask again ${ask === null ? 'n/a' : Math.round((ask - end) * 10) / 10}`);
}

try {
  for (const [w, h] of VIEWPORTS) await run(w, h);
} catch (err) {
  report(false, `error: ${err.message}`);
} finally {
  ws.close();
  cleanup();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
