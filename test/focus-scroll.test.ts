// Guards task 20.1: moving focus into the sticky inscription band must not scroll the page.
// html has scroll-padding-bottom equal to the band's height, so a plain focus() on a band element
// makes the browser scroll to centre it. This scans web/*.ts for `.focus(` calls: each one must either
// pass `preventScroll: true` or appear in NOT_IN_BAND, the calls that target elements outside the
// band (plots, hero and fix controls). A new focus() call fails here until it is classified.
// Browser behaviour itself is checked by scripts/check-resurrect-scroll.mjs.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const NOT_IN_BAND = [
  'if (on && focus) b.focus();', // the plot: keyboard focus on plots should scroll clear of the band
  'statusEl.focus();',
  'if (b && hadFocus) b.focus();', // the plot
  'else plotAt(index)?.focus();', // the plot
  'copyPatchedBtn.focus();',
  'patchedFallback.focus();',
  'address.focus();',
  'source.focus();',
  'copyFallback.focus();',
];

function focusCalls(): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  for (const f of readdirSync('web').filter(n => n.endsWith('.ts'))) {
    readFileSync(`web/${f}`, 'utf8').split(/\r?\n/).forEach((text, n) => {
      if (/\.focus\(/.test(text) && !text.trim().startsWith('//')) out.push({ file: f, line: n + 1, text: text.trim() });
    });
  }
  return out;
}

describe('focus does not scroll the page', () => {
  it('the band links and buttons are focused with preventScroll: true', () => {
    const calls = focusCalls();
    expect(calls.length).toBeGreaterThan(0);
    const banded = calls.filter(c => /ins-action|btn\.focus\(/.test(c.text) && !c.text.includes('copyPatchedBtn'));
    expect(banded.length).toBeGreaterThanOrEqual(2); // Resurrect's link and Ask again's button
    for (const c of banded) expect(c.text, `${c.file}:${c.line}`).toContain('preventScroll: true');
  });

  it('every other focus() call is a known call outside the band', () => {
    for (const c of focusCalls()) {
      if (c.text.includes('preventScroll: true')) continue;
      expect(NOT_IN_BAND.some(k => c.text.includes(k)), `${c.file}:${c.line} ${c.text}`).toBe(true);
    }
  });
});
