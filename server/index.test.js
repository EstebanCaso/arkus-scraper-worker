import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const API_KEY = process.env.WORKER_API_KEY || 'test-key';
const PORT = process.env.PORT || 8099;

let serverProc = null;

function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn('node', ['server/index.js'], {
      env: { ...process.env, WORKER_API_KEY: API_KEY, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const start = Date.now();
    const tryHealth = async () => {
      try {
        const res = await request('GET', '/health');
        if (res.status === 200 && res.json?.ok) return resolve();
      } catch {}
      if (Date.now() - start > 10000) return reject(new Error('server start timeout'));
      setTimeout(tryHealth, 250);
    };
    setTimeout(tryHealth, 250);
  });
}

function stopServer() {
  try { serverProc?.kill('SIGKILL'); } catch {}
}

async function request(method, path, body) {
  const payload = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: PORT,
      path,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-api-key': API_KEY
      },
      timeout: 60000
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d.toString(); });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(data || '{}'); } catch { json = {}; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('integration suite', async (t) => {
  await startServer();

  await t.test('GET /health', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  await t.test('POST /events returns uniform response', async () => {
    const body = { latitude: 32.5250, longitude: -117.0233, radius: 5, userUuid: 'test-user' };
    const res = await request('POST', '/events', body);
    assert.ok([200, 500].includes(res.status));
    assert.ok(typeof res.json.ok === 'boolean');
    if (res.json.ok) {
      assert.ok(Array.isArray(res.json.data));
      assert.ok(typeof res.json.count === 'number');
    } else {
      assert.ok(typeof res.json.error === 'string');
    }
  });

  await t.test('POST /ticketmaster returns uniform response', async () => {
    const body = { latitude: 32.5250, longitude: -117.0233, radius: 10, userUuid: 'test-user' };
    const res = await request('POST', '/ticketmaster', body);
    assert.ok([200, 500].includes(res.status));
    assert.ok(typeof res.json.ok === 'boolean');
    assert.ok(Array.isArray(res.json.data));
    assert.ok(typeof res.json.count === 'number');
  });

  await t.test('POST /hotel returns uniform response', async () => {
    const body = { userUuid: '11111111-1111-1111-1111-111111111111', hotelName: 'Hilton Mexico City', days: 1, concurrency: 3, headless: true };
    const res = await request('POST', '/hotel', body);
    assert.ok([200, 500].includes(res.status));
    assert.ok(typeof res.json.ok === 'boolean');
    if (res.json.ok) {
      assert.ok(Array.isArray(res.json.data));
      const count = res.json.count;
      assert.ok(typeof count === 'number');
    } else {
      assert.ok(typeof res.json.error === 'string');
    }
  });

  stopServer();
});


