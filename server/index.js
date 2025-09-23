import express from 'express';
import cors from 'cors';
import { spawn } from 'node:child_process';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Simple in-memory cache for Amadeus base results by geo key
// Key format: `${lat}:${lon}:${radius}`
const amadeusCache = new Map();
const AMADEUS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function makeAmadeusKey(lat, lon, radius) {
  return `${lat}:${lon}:${radius}`;
}

function isFresh(entry) {
  return entry && (Date.now() - entry.ts) < AMADEUS_CACHE_TTL_MS;
}

// auth simple por x-api-key
app.use((req, res, next) => {
  const key = req.get('x-api-key');
  if (!process.env.WORKER_API_KEY) return res.status(500).json({ ok: false, error: 'WORKER_API_KEY missing' });
  if (key !== process.env.WORKER_API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

function runNodeScript(relPath, args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [relPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', err => resolve({ code: -1, stdout, stderr: String(err?.message || err) }));
  });
}

// POST /amadeus
app.post('/amadeus', async (req, res) => {
  const { latitude, longitude, radius = 30, keyword = null, saveToDb = false, userUuid = null } = req.body || {};
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return res.status(400).json({ ok: false, error: 'latitude/longitude required' });

  const key = makeAmadeusKey(latitude, longitude, radius);

  // If user is typing (keyword present), try to serve from cache fast
  const cached = amadeusCache.get(key);
  if (keyword && isFresh(cached) && Array.isArray(cached.hotels)) {
    const filtered = cached.hotels.filter(h => (h?.name || '').toLowerCase().includes(String(keyword).toLowerCase()));
    const output = JSON.stringify(filtered);
    return res.status(200).json({ ok: true, output, error: '', code: 0 });
  }

  // Build args. If we want to populate cache, call without keyword first
  const baseArgs = [String(latitude), String(longitude), `--radius=${radius}`];
  if (saveToDb && userUuid) baseArgs.push(`--user-id=${userUuid}`, '--save');

  // When no fresh cache, fetch base list (no keyword) to cache
  const { code, stdout, stderr } = await runNodeScript('scripts/amadeus_hotels.js', baseArgs);
  if (code !== 0) {
    return res.status(500).json({ ok: false, output: stdout, error: stderr, code });
  }

  // Parse and cache base result
  let hotels = [];
  try { hotels = JSON.parse(stdout); } catch {}
  amadeusCache.set(key, { hotels, ts: Date.now() });

  // If keyword provided, filter from freshly fetched base
  if (keyword) {
    const filtered = hotels.filter(h => (h?.name || '').toLowerCase().includes(String(keyword).toLowerCase()));
    const output = JSON.stringify(filtered);
    return res.status(200).json({ ok: true, output, error: '', code: 0 });
  }

  // No keyword: return full base result as-is
  return res.status(200).json({ ok: true, output: stdout, error: '', code: 0 });
});

// POST /hotel
app.post('/hotel', async (req, res) => {
  const { userUuid, hotelName, days = 1, concurrency = 3, headless = true, userJwt = '' } = req.body || {};
  if (!userUuid || !hotelName) return res.status(400).json({ ok: false, error: 'userUuid and hotelName required' });
  const args = [userUuid, hotelName, `--days=${days}`, `--concurrency=${concurrency}`];
  if (headless) args.push('--headless');
  const { code, stdout, stderr } = await runNodeScript('scripts/hotel_propio.js', args, { USER_JWT: userJwt });
  return res.status(code === 0 ? 200 : 500).json({ ok: code === 0, output: stdout, error: stderr, code });
});

// POST /events (songkick)
app.post('/events', async (req, res) => {
  const { latitude, longitude, radius = 50 } = req.body || {};
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return res.status(400).json({ ok: false, error: 'latitude/longitude required' });
  const { code, stdout, stderr } = await runNodeScript('scripts/scrape_songkick.js', [String(latitude), String(longitude), String(radius)]);
  return res.status(code === 0 ? 200 : 500).json({ ok: code === 0, output: stdout, error: stderr, code });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Worker listening on :${port}`));