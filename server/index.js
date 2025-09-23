import express from 'express';
import cors from 'cors';
import { spawn } from 'node:child_process';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// auth simple por x-api-key
app.use((req, res, next) => {
  const key = req.get('x-api-key');
  if (!process.env.WORKER_API_KEY) return res.status(500).json({ ok: false, error: 'WORKER_API_KEY missing' });
  if (key !== process.env.WORKER_API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

function runNodeScript(relPath, args = [], env = {}, timeoutMs = 55000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn('node', [relPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '', stderr = '';
    let finished = false;
    const done = (result) => {
      if (finished) return; finished = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      resolve({ ...result, durationMs });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      done({ code: 124, stdout, stderr: (stderr ? stderr + '\n' : '') + 'Timed out' });
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => done({ code, stdout, stderr }));
    child.on('error', err => done({ code: -1, stdout, stderr: String(err?.message || err) }));
  });
}

function parseJsonSafe(str, fallback) {
  try { return JSON.parse(String(str || '')); } catch { return fallback; }
}

// --- Stop flags (per user) ---
const tmpDir = path.join(process.cwd(), 'server', 'tmp');
function ensureTmpDir() { try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {} }
function stopFilePath(userUuid) { return path.join(tmpDir, `stop-${userUuid}.txt`); }
function setStopForUser(userUuid, hotelName = '') {
  ensureTmpDir();
  try { fs.writeFileSync(stopFilePath(userUuid), hotelName || 'selected', 'utf8'); } catch {}
}
function clearStopForUser(userUuid) {
  try { fs.unlinkSync(stopFilePath(userUuid)); } catch {}
}

// POST /select-hotel → marca selección y detiene scraping en curso para ese usuario
app.post('/select-hotel', (req, res) => {
  const { userUuid, hotelName = '' } = req.body || {};
  if (!userUuid) return res.status(400).json({ ok: false, error: 'userUuid required' });
  setStopForUser(userUuid, hotelName);
  return res.json({ ok: true });
});

// POST /clear-selection → limpia bandera de stop
app.post('/clear-selection', (req, res) => {
  const { userUuid } = req.body || {};
  if (!userUuid) return res.status(400).json({ ok: false, error: 'userUuid required' });
  clearStopForUser(userUuid);
  return res.json({ ok: true });
});

// POST /amadeus
// Cache simple para evitar re-ejecutar Amadeus si no cambian los parámetros
let lastAmadeusCache = { key: '', response: null };

app.post('/amadeus', async (req, res) => {
  const { latitude, longitude, radius = 30, keyword = null, saveToDb = false, userUuid = null } = req.body || {};
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return res.status(400).json({ ok: false, error: 'latitude/longitude required' });

  // Solo cachear cuando NO hay operación de guardado (sin efectos secundarios)
  const cacheKey = `${latitude}|${longitude}|${radius}|${keyword || ''}`;
  if (!saveToDb && lastAmadeusCache.key === cacheKey && lastAmadeusCache.response) {
    return res.status(200).json(lastAmadeusCache.response);
  }

  const args = [String(latitude), String(longitude), `--radius=${radius}`];
  if (keyword) args.push(`--keyword=${keyword}`);
  if (saveToDb && userUuid) args.push(`--user-id=${userUuid}`, '--save');

  const { code, stdout, stderr, durationMs } = await runNodeScript('scripts/amadeus_hotels.js', args);
  const json = { ok: code === 0, output: stdout, error: stderr, code, durationMs };

  if (!saveToDb) {
    lastAmadeusCache = { key: cacheKey, response: json };
  }
  return res.status(code === 0 ? 200 : 500).json(json);
});

// POST /hotel
app.post('/hotel', async (req, res) => {
  const startedAt = Date.now();
  try {
    const { userUuid, hotelName, days = 1, concurrency = 3, headless = true, userJwt = '' } = req.body || {};
    if (!userUuid || !hotelName) return res.status(400).json({ ok: false, error: 'userUuid and hotelName required' });
    const args = [userUuid, hotelName, `--days=${days}`, `--concurrency=${concurrency}`];
    if (headless) args.push('--headless');
    const { code, stdout, stderr, durationMs } = await runNodeScript('scripts/hotel_propio.js', args, { USER_JWT: userJwt }, 55000);
    const data = Array.isArray(parseJsonSafe(stdout, null)) ? parseJsonSafe(stdout, []) : [];
    const count = Array.isArray(data) ? data.reduce((acc, d) => acc + (Array.isArray(d?.rooms) ? d.rooms.length : 0), 0) : 0;
    if (code !== 0 && count === 0) {
      console.error('[hotel] non-zero exit or empty data', { code, stderr, durationMs });
    }
    return res.status(code === 0 ? 200 : 500).json({ ok: code === 0, data, count, code, error: code === 0 ? undefined : stderr, durationMs, startedAt });
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    console.error('[hotel] error', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e), durationMs, startedAt });
  }
});

// POST /events (songkick)
app.post('/events', async (req, res) => {
  const startedAt = Date.now();
  try {
    const { latitude, longitude, radius = 50, userUuid = null, hotelName = '' } = req.body || {};
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return res.status(400).json({ ok: false, error: 'latitude/longitude required' });
    const args = [String(latitude), String(longitude), String(radius)];
    const { code, stdout, stderr, durationMs } = await runNodeScript('scripts/scrape_songkick.js', args, {}, 55000);
    const data = Array.isArray(parseJsonSafe(stdout, null)) ? parseJsonSafe(stdout, []) : [];
    const count = Array.isArray(data) ? data.length : 0;
    if (count === 0) {
      console.log('[events] 0 events', { latitude, longitude, radius });
    }
    return res.status(code === 0 ? 200 : 500).json({ ok: code === 0, data, count, code, error: code === 0 ? undefined : stderr, durationMs, startedAt });
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    console.error('[events] error', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e), durationMs, startedAt });
  }
});

// POST /ticketmaster (Ticketmaster)
app.post('/ticketmaster', async (req, res) => {
  const startedAt = Date.now();
  try {
    const { latitude, longitude, radius = 10, userUuid = null } = req.body || {};
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return res.status(400).json({ ok: false, error: 'latitude/longitude required' });
    const hasKey = !!process.env.TICKETMASTER_API_KEY;
    if (!hasKey) {
      console.log('[ticketmaster] No API key present');
    }
    const args = [String(latitude), String(longitude), String(radius)];
    const { code, stdout, stderr, durationMs } = await runNodeScript('scripts/scrapeo_geo.js', args, {}, 55000);
    const data = Array.isArray(parseJsonSafe(stdout, null)) ? parseJsonSafe(stdout, []) : [];
    const count = Array.isArray(data) ? data.length : 0;
    return res.status(code === 0 ? 200 : 500).json({ ok: code === 0, data, count, code, error: code === 0 ? undefined : stderr, durationMs, startedAt, note: hasKey ? undefined : 'No API key' });
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    console.error('[ticketmaster] error', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e), durationMs, startedAt });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Worker listening on :${port}`));