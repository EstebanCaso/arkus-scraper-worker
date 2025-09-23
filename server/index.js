import express from 'express';
import cors from 'cors';
import { spawn } from 'node:child_process';

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

  const { code, stdout, stderr } = await runNodeScript('scripts/amadeus_hotels.js', args);
  const json = { ok: code === 0, output: stdout, error: stderr, code };

  if (!saveToDb) {
    lastAmadeusCache = { key: cacheKey, response: json };
  }
  return res.status(code === 0 ? 200 : 500).json(json);
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