// Task 19.1: CSS facts of the load assembly (Requirement 6.20). The timing itself is checked in a browser.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

describe('load assembly', () => {
  it('keeps the from state inside keyframes only', () => {
    expect(css).toMatch(/@keyframes assemble-rise \{ from \{ opacity: 0; transform: translateY\(28px\); \} \}/);
    const outsideKeyframes = css.replace(/@keyframes[^{]+\{(?:[^{}]|\{[^}]*\})*\}/g, '');
    const baseRules = outsideKeyframes.replace(/@media[^{]+\{(?:[^{}]|\{[^}]*\})*\}/g, '');
    expect(baseRules).not.toMatch(/\.(hill|tree|gate|fence|moonbox|mist)\b[^{]*\{[^}]*opacity:\s*0\b/);
  });

  it('holds the mist only when motion is allowed, and the class starts in the HTML', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.rv \.ground\.assembling \.mist \{ opacity: 0; \}/);
    expect(html).toContain('class="ground assembling"');
  });

  it('does not animate the moon or the sky, which JS writes to', () => {
    expect(css).not.toMatch(/\.rv \.(moon|sky)\s*\{[^}]*animation:/);
  });
});
