// Checks every samples/*.md that ends with an "Expected verdicts:" comment against the CLI.
// Prints only links whose verdict differs from the comment; exits 1 if there are any.
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const VERDICTS = ['alive', 'dead', 'possessed', 'restless'];
const key = (u) => { const x = new URL(u); return x.hostname.replace(/^www\./, '') + x.pathname; };

function parse(text) {
  const m = /<!--\s*Expected verdicts:([\s\S]*?)-->/.exec(text);
  if (!m) return null;
  const rules = []; // { host, path, verdicts: Set }
  let last = null;
  for (const line of m[1].split('\n')) {
    const head = /^(alive|dead|possessed|restless)\s+(.*)$/.exec(line.trim());
    if (head) {
      last = head[1];
      for (const part of head[2].replace(/\([^)]*\)/g, '').split(',')) {
        const [host, ...path] = part.split('->')[0].trim().split('/');
        if (host) rules.push({ host, path: path.join('/'), verdicts: new Set([last]) });
      }
    }
    // Continuation such as `(kiko.com is occasionally restless ...)`: the link may also be that verdict.
    const alt = /([\w.-]+)\s+is occasionally\s+(\w+)/.exec(line);
    if (!head && alt) rules.filter((r) => r.host === alt[1]).forEach((r) => r.verdicts.add(alt[2]));
  }
  return rules;
}

let bad = 0;
for (const f of readdirSync('samples').filter((n) => n.endsWith('.md'))) {
  const file = `samples/${f}`;
  const rules = parse(readFileSync(file, 'utf8'));
  if (!rules) continue;
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', file, '--json'], { encoding: 'utf8' });
  let links;
  try { links = JSON.parse(run.stdout).links; } catch { console.log(`${file}: CLI gave no JSON: ${run.stderr.trim()}`); process.exit(1); }
  for (const l of links) {
    const k = key(l.url);
    const rule = rules.find((r) => k.startsWith(r.host + (r.path ? '/' + r.path : '')));
    const want = rule ? [...rule.verdicts].join(' or ') : 'a listed verdict';
    if (rule && rule.verdicts.has(l.verdict)) continue;
    bad++;
    console.log(`${file}: expected ${want}, got ${l.verdict}: ${l.url} — ${l.reason}`);
  }
}
process.exit(bad ? 1 : 0);
