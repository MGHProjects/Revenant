// Debug parseIPv4 and isBlockedIPv4

function parseIPv4(host: string): number | undefined {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return undefined;
  const nums: number[] = [];
  for (const part of parts) {
    if (part === '' || !/^[0-9]+$/.test(part)) return undefined;
    const n = Number(part);
    if (!Number.isFinite(n) || n < 0) return undefined;
    nums.push(n);
  }
  if (nums.length === 1) {
    const v = nums[0];
    if (v > 0xffffffff) return undefined;
    return v >>> 0;
  }
  if (nums.length === 2) {
    if (nums[0] > 0xff || nums[1] > 0xffffff) return undefined;
    return (((nums[0] << 24) | nums[1]) >>> 0);
  }
  if (nums.length === 3) {
    if (nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return undefined;
    return (((nums[0] << 24) | (nums[1] << 16) | nums[2]) >>> 0);
  }
  if (nums.some(n => n > 0xff)) return undefined;
  return (((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0);
}

function isBlockedIPv4(ip: number): boolean {
  if ((ip & 0xff000000) === 0x00000000) return true;
  if ((ip & 0xff000000) === 0x0a000000) return true;
  if ((ip & 0xffc00000) === 0x64400000) return true;
  if ((ip & 0xff000000) === 0x7f000000) return true;
  if ((ip & 0xffff0000) === 0xa9fe0000) return true;
  if ((ip & 0xfff00000) === 0xac100000) return true;
  if ((ip & 0xffff0000) === 0xc0a80000) return true;
  return false;
}

for (const h of ['172.16.0.1', '192.168.1.1', '169.254.1.1']) {
  const ip = parseIPv4(h);
  if (ip === undefined) { console.log(h, '-> parseIPv4 returned undefined'); continue; }
  const hex = '0x' + ip.toString(16).padStart(8, '0');
  console.log(h, '->', ip, hex, 'blocked:', isBlockedIPv4(ip));
  
  // Check masks manually
  console.log('  172.16/12 mask:', ((ip & 0xfff00000) >>> 0).toString(16), '=== 0xac100000?', (ip & 0xfff00000) === 0xac100000);
  console.log('  192.168/16 mask:', ((ip & 0xffff0000) >>> 0).toString(16), '=== 0xc0a80000?', (ip & 0xffff0000) === 0xc0a80000);
  console.log('  169.254/16 mask:', ((ip & 0xffff0000) >>> 0).toString(16), '=== 0xa9fe0000?', (ip & 0xffff0000) === 0xa9fe0000);
}

// Check ::ffff:c0a8:101
// c0a8 = 192.168, 0101 = 1.1
// So groups 6=0xc0a8, 7=0x0101
// ipv4 = (0xc0a8 << 16) | 0x0101 = 0xc0a80101
const g6 = 0xc0a8, g7 = 0x0101;
const ipv4mapped = ((g6 << 16) | g7) >>> 0;
console.log('\n::ffff:c0a8:101 -> IPv4:', ipv4mapped.toString(16), 'blocked:', isBlockedIPv4(ipv4mapped));
