// Runs Vite and `wrangler dev` together; stops both when either exits or on Ctrl+C.
import { spawn, spawnSync } from 'node:child_process';

const win = process.platform === 'win32';
const children = ['dev:web', 'dev:api'].map((s) =>
  spawn('npm', ['run', s], { stdio: 'inherit', shell: win }),
);

let done = false;
function stop(code) {
  if (done) return;
  done = true;
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue;
    if (win) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  process.exit(code);
}

for (const c of children) c.on('exit', (code) => stop(code ?? 1));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(0));
