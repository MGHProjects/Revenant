import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { chooseLife } from '../src/core/lives.js';
import type { Capture } from '../src/core/types.js';

// Real CDX answers fetched from web.archive.org on 25 Nov 2026 with the client's exact query.
function load(name: string): Capture[] {
  const rows = JSON.parse(readFileSync(new URL(`./fixtures/cdx-${name}.json`, import.meta.url), 'utf8')) as string[][];
  return rows.slice(1).map(([timestamp, length]) => ({
    timestamp: timestamp!,
    length: length !== undefined && /^\d+$/.test(length) ? Number(length) : undefined,
  }));
}

describe('chooseLife on real CDX series', () => {
  it.each([
    ['dmoz', '20170301000315'],
    ['freebase', '20150501201938'],
    ['codeplex', '20170101075357'],
    ['geocities', '19990202115713'],
  ])('%s: the copy is %s', (name, copy) => {
    const life = chooseLife(load(name))!;
    expect(life.copy).toBe(copy);
    expect(life.first <= life.copy && life.copy <= life.last).toBe(true);
  });
});