// Runs the web portal and the Discord bot as two child processes in one
// Railway service. They have to share a single service because Railway
// can't attach one Volume to two different services - see the commit
// message on this file for the full reasoning. Each child is supervised
// independently with backoff: one crashing doesn't take the other down,
// and Railway's own restart policy only needs to kick in if this
// supervisor itself dies.

const { spawn } = require('child_process');
const path = require('path');

const CHILDREN = [
  { name: 'portal', script: path.join(__dirname, 'server.js') },
  { name: 'bot', script: path.join(__dirname, 'bot', 'src', 'index.js') }
];

const MAX_BACKOFF_MS = 60000;

function launch(child) {
  let backoffMs = 2000;

  function start() {
    console.log(`[SUPERVISOR] Starting ${child.name} (${child.script})`);
    const proc = spawn(process.execPath, [child.script], {
      stdio: 'inherit',
      env: process.env
    });

    const startedAt = Date.now();

    proc.on('exit', (code, signal) => {
      const ranMs = Date.now() - startedAt;
      console.error(`[SUPERVISOR] ${child.name} exited (code=${code} signal=${signal}) after ${Math.round(ranMs / 1000)}s`);

      // Ran for a while before dying - treat as a fresh problem, not a crash
      // loop, and reset the backoff instead of letting it stay maxed out.
      if (ranMs > MAX_BACKOFF_MS) {
        backoffMs = 2000;
      }

      console.error(`[SUPERVISOR] Restarting ${child.name} in ${Math.round(backoffMs / 1000)}s`);
      setTimeout(start, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    });

    proc.on('error', (err) => {
      console.error(`[SUPERVISOR] Failed to spawn ${child.name}:`, err.message);
    });
  }

  start();
}

CHILDREN.forEach(launch);

process.on('SIGTERM', () => {
  console.log('[SUPERVISOR] Received SIGTERM, exiting.');
  process.exit(0);
});
