## arkus-scraper-worker – Self‑hosted Deployment Guide

This service exposes HTTP endpoints that trigger scraping tasks using Node.js and Playwright. Below are two supported deployment paths for a self‑hosted Linux server: native (Node) and Docker.

### 1) Requirements
- Linux x64 (Ubuntu 22.04+ recommended)
- Node.js 18+ (or Docker 24+)
- For native install: Playwright Chromium dependencies
- A reverse proxy (optional but recommended): Nginx or Caddy

### 2) Clone and prepare
```bash
git clone <your-fork-or-repo-url>.git arkus-scraper-worker
cd arkus-scraper-worker
cp .env.example .env  # if you keep one; otherwise create .env (see variables below)
npm ci --omit=dev
# Install Playwright Chromium when running natively
npx --yes playwright install chromium
```

### 3) Environment variables
Create a file named `.env` in the project root with the settings you need. Common variables:

```bash
# Server
PORT=8080
WORKER_API_KEY=your-strong-api-key
SCRAPER_TIMEOUT_MS=1200000

# Playwright/Chromium runs in the official container image if you use Docker.
# For native install on low-RAM hosts consider headless and reduced concurrency from the caller.

# Amadeus
AMADEUS_API_KEY=...
AMADEUS_API_SECRET=...

# Supabase (optional for saving data)
SUPABASE_URL=...
SUPABASE_ANON_KEY=...

# Ticketmaster 
TICKETMASTER_API_KEY=...
```

Keep this file out of source control.

### 4A) Run natively (Node)
Install missing system libraries for Chromium. On Ubuntu:

```bash
sudo apt update
sudo apt install -y wget ca-certificates fonts-liberation libasound2 \
  libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 libdbus-1-3 \
  libdrm2 libgbm1 libgtk-3-0 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  libxshmfence1

# From repo root
export $(grep -v '^#' .env | xargs) 2>/dev/null || true
node server/index.js
```

Production process manager (PM2 or systemd) is recommended.

systemd example `/etc/systemd/system/arkus-scraper-worker.service`:
```
[Unit]
Description=Arkus Scraper Worker
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/arkus-scraper-worker
EnvironmentFile=/opt/arkus-scraper-worker/.env
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /opt/arkus-scraper-worker
sudo chown -R $USER: /opt/arkus-scraper-worker
rsync -a --exclude node_modules ./ /opt/arkus-scraper-worker/
cd /opt/arkus-scraper-worker && npm ci --omit=dev && npx --yes playwright install chromium
sudo systemctl daemon-reload
sudo systemctl enable --now arkus-scraper-worker
sudo journalctl -u arkus-scraper-worker -f
```

### 4B) Run with Docker (recommended for simplicity)

The repo already contains a `dockerfile` based on the official Playwright image.

```bash
docker build -t arkus-scraper-worker:latest .
docker run -d --name arkus-scraper-worker \
  --restart unless-stopped \
  -p 8080:8080 \
  --env-file ./.env \
  arkus-scraper-worker:latest
```

Tip: mount a volume if you want persistent screenshots/logs.

### 5) Reverse proxy (optional)
Nginx snippet:
```
server {
  listen 80;
  server_name your.domain.com;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Use HTTPS (Let’s Encrypt) in production.

### 6) Health check
```bash
curl -s http://localhost:8080/health -H "x-api-key: $WORKER_API_KEY"
```

### 7) API usage (examples)
- Amadeus near hotels (no DB write):
```bash
curl -X POST http://localhost:8080/amadeus \
  -H "Content-Type: application/json" \
  -H "x-api-key: $WORKER_API_KEY" \
  -d '{"latitude":32.52229,"longitude":-117.01931,"radius":30,"keyword":"grand hotel"}'
```

- Booking hotel scrape (multi-day):
```bash
curl -X POST http://localhost:8080/hotel \
  -H "Content-Type: application/json" \
  -H "x-api-key: $WORKER_API_KEY" \
  -d '{"userUuid":"044e6abe-d1a0-4e46-8163-29223e74d9da","hotelName":"GRAND HOTEL TIJUANA","days":90,"concurrency":3,"headless":true,"userJwt":"<optional-supabase-user-jwt>"}'
```

- Songkick events:
```bash
curl -X POST http://localhost:8080/events \
  -H "Content-Type: application/json" \
  -H "x-api-key: $WORKER_API_KEY" \
  -d '{"latitude":32.53079,"longitude":-117.01996,"radius":50}'
```

- Ticketmaster events (requires `TICKETMASTER_API_KEY`):
```bash
curl -X POST http://localhost:8080/ticketmaster \
  -H "Content-Type: application/json" \
  -H "x-api-key: $WORKER_API_KEY" \
  -d '{"latitude":32.53079,"longitude":-117.01996,"radius":10}'
```

### 8) Production notes
- Security: all endpoints require `x-api-key` (`WORKER_API_KEY`). Keep this secret.
- Timeouts: default is 20 minutes; adjust with `SCRAPER_TIMEOUT_MS`.
- Playwright flags: in CI/containers, Chromium often needs `--no-sandbox` and `--disable-dev-shm-usage`. The provided `dockerfile` already installs Chromium via Playwright.
- Concurrency: the Booking scraper accepts `--concurrency`. Tune down on small servers to avoid OOM.
- Headless: use `headless` in production for stability.
- Logs: check process logs (`journalctl -u ...`) or `docker logs -f arkus-scraper-worker`.

### 9) Troubleshooting
- Chromium fails to launch:
  - Native: ensure all listed libs are installed; re-run `npx playwright install chromium`.
  - Use Docker image to avoid host lib mismatches.
- Empty results on Booking/Songkick:
  - Try smaller `days`/`concurrency` and ensure `headless: true`.
  - Some properties/pages block aggressively; retry with different `USER_JWT` (if using Supabase RLS) and ensure stable network.
- OOM/Memory pressure:
  - Reduce concurrency (e.g., 1–2)
  - Prefer Docker and allocate enough RAM (>=1 GB recommended for concurrent pages)

### 10) Updating
```bash
git pull
npm ci --omit=dev
npx --yes playwright install chromium
sudo systemctl restart arkus-scraper-worker   # or restart the Docker container
```


