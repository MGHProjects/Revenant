import { describe, it, expect } from 'vitest';
import { chooseLife } from '../src/core/lives.js';
import type { Capture } from '../src/core/types.js';

describe('chooseLife', () => {
  it('dmoz: the long life ends in soft-404 pages and the 2025 gambling site; neither is the copy', () => {
    const caps: Capture[] = [];
    for (let y = 1999; y <= 2016; y++) {
      for (let m = 1; m <= 12; m++) {
        if (y === 1999 && m < 4) continue;
        caps.push({ timestamp: `${y}${String(m).padStart(2, '0')}10120000`, length: 5000 });
      }
    }
    const tail: Array<[string, number]> = [
      ['20170101', 4684], ['20170201', 4682], ['20170301', 4895], ['20170401', 981],
      ['20170501', 985], ['20170601', 986], ['20170701', 966], ['20170802', 804],
      ['20170901', 1155], ['20171006', 956], ['20171105', 1126], ['20171203', 1120],
      ['20180104', 973], ['20180316', 1966],
    ];
    for (const [d, length] of tail) caps.push({ timestamp: `${d}120000`, length });
    caps.push({ timestamp: '20250305234014', length: 5200 });

    const r = chooseLife(caps)!;
    expect(r.first).toBe('19990410120000');
    expect(r.last).toBe('20180316120000');
    expect(r.copy).toBe('20170301120000');
    expect(r.copy).not.toMatch(/^2018/);
    expect(r.last).not.toBe('20250305234014');
  });
  it('a gap of exactly 12 months keeps one life; 13 months splits it', () => {
    const a = { timestamp: '20100115000000', length: 100 };
    expect(chooseLife([a, { timestamp: '20110115000000', length: 100 }])!.last).toBe('20110115000000');
    expect(chooseLife([a, { timestamp: '20110215000000', length: 100 }])!.last).toBe('20100115000000');
  });
});
