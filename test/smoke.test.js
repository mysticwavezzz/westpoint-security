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

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(BASE_URL + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
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

test('GET /api/my-reports rejects unauthenticated requests', async () => {
  const res = await get('/api/my-reports');
  assert.strictEqual(res.status, 401);
});

test('GET /api/careers/positions returns a positions array', async () => {
  const res = await get('/api/careers/positions');
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.positions));
  assert.ok(body.positions.length > 0);
});

test('POST /api/careers/apply rejects unauthenticated requests', async () => {
  const res = await post('/api/careers/apply', { positionId: 'POS-1001' });
  assert.strictEqual(res.status, 401);
});

test('GET /api/admin/careers/applications rejects unauthenticated requests', async () => {
  const res = await get('/api/admin/careers/applications');
  assert.strictEqual(res.status, 403);
});

test('GET /api/public/transparency returns aggregate-only, redacted shape', async () => {
  const res = await get('/api/public/transparency');
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.byMonth));
  assert.ok(Array.isArray(body.byAction));
  const json = res.body;
  assert.ok(!json.includes('"officer"'));
  assert.ok(!json.includes('"suspect"'));
  assert.ok(!json.includes('"summary"'));
});

test('command-only endpoints reject unauthenticated requests', async () => {
  const res = await get('/api/admin/channels');
  assert.strictEqual(res.status, 403);
});

test('GET /api/push/vapid-public-key rejects unauthenticated requests', async () => {
  const res = await get('/api/push/vapid-public-key');
  assert.strictEqual(res.status, 401);
});

test('POST /api/push/subscribe rejects unauthenticated requests', async () => {
  const res = await post('/api/push/subscribe', {});
  assert.strictEqual(res.status, 401);
});

test('POST /api/push/unsubscribe rejects unauthenticated requests', async () => {
  const res = await post('/api/push/unsubscribe', {});
  assert.strictEqual(res.status, 401);
});

test('GET /sw.js is served as a static file', async () => {
  const res = await get('/sw.js');
  assert.strictEqual(res.status, 200);
});

test('GET /api/admin/analytics rejects unauthenticated requests', async () => {
  const res = await get('/api/admin/analytics');
  assert.strictEqual(res.status, 403);
});

test('GET /api/admin/flags/quota-risk rejects unauthenticated requests', async () => {
  const res = await get('/api/admin/flags/quota-risk');
  assert.strictEqual(res.status, 403);
});

test('GET /api/admin/flags/stale-ia rejects unauthenticated requests', async () => {
  const res = await get('/api/admin/flags/stale-ia');
  assert.strictEqual(res.status, 403);
});

test('GET /api/admin/bodycam/review-queue rejects unauthenticated requests', async () => {
  const res = await get('/api/admin/bodycam/review-queue');
  assert.strictEqual(res.status, 403);
});

test('GET /api/admin/bodycam/search rejects unauthenticated requests', async () => {
  const res = await get('/api/admin/bodycam/search?tag=Arrest');
  assert.strictEqual(res.status, 403);
});

test('POST /api/admin/bodycam/audit-randomizer/run rejects unauthenticated requests', async () => {
  const res = await post('/api/admin/bodycam/audit-randomizer/run', {});
  assert.strictEqual(res.status, 403);
});

test('GET /api/admin/bodycam/audit-randomizer/history rejects unauthenticated requests', async () => {
  const res = await get('/api/admin/bodycam/audit-randomizer/history');
  assert.strictEqual(res.status, 403);
});

test('POST /api/bodycam/:id/tags rejects unauthenticated requests', async () => {
  const res = await post('/api/bodycam/nonexistent/tags', { tags: ['Arrest'] });
  assert.strictEqual(res.status, 401);
});

test('GET /manifest.json is served and parses as valid JSON', async () => {
  const res = await get('/manifest.json');
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.short_name, 'Westpoint');
});

test('unknown routes 404', async () => {
  const res = await get('/this-route-does-not-exist-xyz');
  assert.strictEqual(res.status, 404);
});
