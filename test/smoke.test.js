// Basic smoke tests - no test infrastructure existed at all before this
// (confirmed: no test script, no test framework installed, no test files).
// Uses node:test/node:assert, both built into Node 18+, so this adds zero
// new dependencies. Spawns the real server as a child process on a
// dedicated test port rather than requiring server.js in-process, since it
// calls .listen() immediately at module load with no exported app to hook
// into - the least invasive way to get real coverage without refactoring
// the whole file's structure.
//
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const TEST_PORT = 8099;
// 127.0.0.1, not 'localhost' - Node can resolve 'localhost' to the IPv6
// ::1 first on Windows, which the server (bound to 0.0.0.0, IPv4 only)
// refuses, surfacing as an misleading ECONNREFUSED/AggregateError that
// looks like a dead server even when it started fine.
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
let serverProcess;

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get(BASE_URL + pathname, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

before(async () => {
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: 'pipe'
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start within 10s')), 10000);
    let output = '';
    serverProcess.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('Live at')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.on('error', (err) => { clearTimeout(timeout); reject(err); });
    serverProcess.on('exit', (code) => {
      if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error('Server exited early with code ' + code)); }
    });
  });
});

after(() => {
  if (serverProcess) serverProcess.kill();
});

test('GET /api/health reports ok', async () => {
  const res = await get('/api/health');
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.status, 'ok');
  assert.strictEqual(typeof body.uptimeSeconds, 'number');
});

test('GET / serves the public homepage', async () => {
  const res = await get('/');
  assert.strictEqual(res.status, 200);
});

test('GET /api/news returns a news array', async () => {
  const res = await get('/api/news');
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.news));
});

test('GET /api/public/blotter returns a redacted blotter array', async () => {
  const res = await get('/api/public/blotter');
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blotter));
  // Redaction guarantee - never leak officer/suspect identity here.
  for (const entry of body.blotter) {
    assert.ok(!('officer' in entry));
    assert.ok(!('suspect' in entry));
    assert.ok(!('summary' in entry));
  }
});

test('GET /api/public/patrol-count returns a numeric count', async () => {
  const res = await get('/api/public/patrol-count');
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(typeof body.count, 'number');
});

test('GET /api/report/:id/status 404s for an unknown case number', async () => {
  const res = await get('/api/report/DESK-000000/status');
  assert.strictEqual(res.status, 404);
});

test('officer-only endpoints reject unauthenticated requests', async () => {
  const res = await get('/api/staff-directory');
  assert.strictEqual(res.status, 401);
});

test('command-only endpoints reject unauthenticated requests', async () => {
  const res = await get('/api/admin/channels');
  assert.strictEqual(res.status, 403);
});

test('unknown routes 404', async () => {
  const res = await get('/this-route-does-not-exist-xyz');
  assert.strictEqual(res.status, 404);
});
