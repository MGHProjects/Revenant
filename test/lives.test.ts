import { describe, it, expect } from 'vitest';
import { chooseLife } from '../src/core/lives.js';
import type { Capture } from '../src/core/types.js';

describe('chooseLife', () => {
  it('dmoz: the long life ends before the parked page, and the 2025 gambling site is never chosen', () => {
    const caps: Capture[] = [];
    for (let y = 1999; y <= 2017; y++) {
      for (let m = 1; m <= 12; m++) {
        if (y === 1999 && m < 4) continue;
        caps.push({ timestamp: `${y}${String(m).padStart(2, '0')}10120000`, length: 5000 });
      }
    }
    caps.push({ timestamp: '20180110120000', length: 973 });
    caps.push({ timestamp: '20250305234014', length: 5200 });

    const r = chooseLife(caps)!;
    expect(r.first).toBe('19990410120000');
    expect(r.last).toBe('20171210120000');
    expect(r.last).not.toBe('20250305234014');
  });

  it('single capture is both first and last', () => {
    expect(chooseLife([{ timestamp: '20100101000000', length: undefined }])).toEqual({
      first: '20100101000000',
      last: '20100101000000',
    });
  });

  it('a gap of exactly 12 months keeps one life; 13 months splits it', () => {
    const a = { timestamp: '20100115000000', length: 100 };
    expect(chooseLife([a, { timestamp: '20110115000000', length: 100 }])!.last).toBe('20110115000000');
    expect(chooseLife([a, { timestamp: '20110215000000', length: 100 }])!.last).toBe('20100115000000');
  });
});
