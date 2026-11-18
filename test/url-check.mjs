const cases = [
  'http://0x7f000001/',
  'http://0177.0.0.1/',
  'http://2130706433/',
  'http://[::1]/',
  'http://[fe80::1]/',
  'http://[::ffff:192.168.1.1]/',
  'http://[fc00::1]/',
  'http://192.168.1.1/',
  'http://10.0.0.1/',
  'http://1.2.3.4/',
  'https://example.com/'
];
for (const u of cases) {
  try {
    const p = new URL(u);
    console.log(u.padEnd(40), '->', p.hostname);
  } catch(e) {
    console.log(u.padEnd(40), '-> PARSE ERROR');
  }
}
