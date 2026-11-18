// Quick smoke test — not a formal test file, just manual verification.
// Run with: node test/guard-smoke.mjs

// We need to transpile/import guard.ts via tsx or ts-node.
// Use the compiled output for now.
import { execSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';

// Write a temporary runner that calls guard directly after transpilation.
const runner = `
import { guard } from './src/core/guard.ts';

const cases = [
  // Should be blocked
  ['http://127.0.0.1/', 'loopback IPv4'],
  ['http://10.0.0.1/', 'private 10/8'],
  ['http://172.16.0.1/', 'private 172.16/12'],
  ['http://192.168.1.1/', 'private 192.168/16'],
  ['http://169.254.1.1/', 'link-local IPv4'],
  ['http://100.64.0.1/', 'CGNAT'],
  ['http://0.1.2.3/', '0/8'],
  ['http://[::1]/', 'loopback IPv6'],
  ['http://[fe80::1]/', 'link-local IPv6'],
  ['http://[fc00::1]/', 'ULA IPv6'],
  ['http://[::ffff:c0a8:101]/', 'IPv4-mapped private'],
  ['http://[::ffff:7f00:1]/', 'IPv4-mapped loopback'],
  ['ftp://example.com/', 'wrong scheme'],
  ['http://user:pass@example.com/', 'credentials'],
  ['http://localhost/', 'localhost'],
  ['http://foo.local/', '.local'],
  ['http://foo.internal/', '.internal'],
  ['http://foo.localhost/', '.localhost'],
  // Should be allowed
  ['https://example.com/', 'public domain'],
  ['http://1.2.3.4/', 'public IPv4'],
  ['http://[2001:db8::1]/', 'documentation IPv6'],
];

let pass = 0, fail = 0;
for (const [url, label] of cases) {
  const result = guard(url);
  const shouldBlock = !['public domain', 'public IPv4', 'documentation IPv6'].includes(label);
  const blocked = result.ok === false;
  const ok = shouldBlock === blocked;
  if (!ok) {
    console.error('FAIL', url, label, '->', JSON.stringify(result));
    fail++;
  } else {
    console.log('OK  ', url.padEnd(45), shouldBlock ? 'blocked: ' + result.reason : 'allowed');
    pass++;
  }
}
console.log('\\n' + pass + ' passed, ' + fail + ' failed');
`;

writeFileSync('/tmp/guard-smoke-runner.ts', runner);
try {
  const out = execSync('node --loader tsx /tmp/guard-smoke-runner.ts 2>&1', { encoding: 'utf8', cwd: process.cwd() });
  console.log(out);
} catch(e) {
  console.error(e.stdout || e.message);
} finally {
  rmSync('/tmp/guard-smoke-runner.ts', { force: true });
}
