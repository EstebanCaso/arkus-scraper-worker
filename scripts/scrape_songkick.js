// dotenv/config not needed in Vercel - env vars are already available
import { chromium } from 'playwright'
import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'

const MAX_RETRIES = 3
const BROWSER_LAUNCH_TIMEOUT = 90_000
const PAGE_LOAD_TIMEOUT = 120_000

function resolveSongkickUrl(lat, lon, radiusKm) {
	if (lat && lon) {
		if (lat > 19.0 && lat < 33.0 && lon > -118.0 && lon < -86.0) {
			if (lat > 32.0) return 'https://www.songkick.com/metro-areas/31097-mexico-tijuana/calendar'
			if (lat > 25.0) return 'https://www.songkick.com/metro-areas/31098-mexico-monterrey/calendar'
			if (lat > 20.0) return 'https://www.songkick.com/metro-areas/31099-mexico-guadalajara/calendar'
			return 'https://www.songkick.com/metro-areas/31100-mexico-mexico-city/calendar'
		}
		return `https://www.songkick.com/search?query=&location=${lat},${lon}&radius=${radiusKm}`
	}
	return 'https://www.songkick.com/metro-areas/31097-mexico-tijuana/calendar'
}

export async function scrapeSongkick(lat, lon, radiusKm) {
	const BASE_URL = 'https://www.songkick.com'
	const URL = resolveSongkickUrl(lat, lon, radiusKm)
	const DEBUG = String(process.env.DEBUG || '').toLowerCase() === 'true'

	let browser
	try {
		if (DEBUG) console.error('[songkick] Launching browser…')
		browser = await chromium.launch({ headless: !DEBUG ? true : false, timeout: BROWSER_LAUNCH_TIMEOUT, slowMo: DEBUG ? 100 : 0, args: [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-blink-features=AutomationControlled',
			'--disable-web-security',
			'--disable-dev-shm-usage'
		] })
		const context = await browser.newContext({
			userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
			bypassCSP: true,
			viewport: { width: 1366, height: 768 },
			extraHTTPHeaders: {
				'accept-language': 'es-ES,es;q=0.9,en;q=0.8'
			}
		})
		const page = await context.newPage()
		// Block third-party noise (ads/trackers) to stabilize DOM
		await context.route('**/*', (route) => {
			try {
				const u = new URL(route.request().url())
				const host = u.hostname
				const allow = host.endsWith('songkick.com')
				if (allow) return route.continue()
				return route.abort()
			} catch { return route.continue() }
		})
		if (DEBUG) {
			page.on('console', (msg) => console.error('[songkick][page]', msg.type(), msg.text()))
			page.on('pageerror', (err) => console.error('[songkick][pageerror]', err?.message || err))
		}
		if (DEBUG) console.error('[songkick] Navigating to', URL)
		await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT })
		// Handle cookie banner if present (including iframes and shadow DOM)
		async function acceptCookies(p) {
			let clicked = false
			const tryClick = async (locator) => {
				if (clicked) return
				try {
					const el = await p.$(locator)
					if (el) {
						if (DEBUG) console.error('[songkick] Clicking cookie button:', locator)
						await el.click({ timeout: 1500 }).catch(()=>{})
						clicked = true
					}
				} catch {}
			}

			const selectors = [
				'button#onetrust-accept-btn-handler',
				'button[aria-label="Accept all"]',
				'button:has-text("Accept all")',
				'button:has-text("Accept")',
				'button:has-text("Agree")',
				'button:has-text("Aceptar")',
				'button:has-text("Aceptar todo")',
				'button:has-text("Estoy de acuerdo")',
				'button:has-text("Consent")',
				'button:has-text("I agree")'
			]
			for (const s of selectors) { await tryClick(s); if (clicked) break }

			// Try common cookie iframes
			try {
				for (const frame of p.frames()) {
					if (clicked) break
					for (const s of selectors) {
						await tryClick(`${s}`)
						if (clicked) break
						try {
							const el = await frame.$(s)
							if (el) {
								if (DEBUG) console.error('[songkick] Clicking cookie in frame:', s)
								await el.click({ timeout: 1500 }).catch(()=>{})
								clicked = true
								break
							}
						} catch {}
					}
				}
			} catch {}

			// Set a consent flag to avoid re-prompts within this context
			try { await p.addInitScript(() => { try { localStorage.setItem('cookie_consent', 'true') } catch {} }) } catch {}
			return clicked
		}
		try { await acceptCookies(page) } catch {}
		await page.waitForTimeout(2000)
		// Try to ensure content populated
		try { await page.waitForLoadState('networkidle', { timeout: 20_000 }) } catch {}
		// Progressive scroll to trigger lazy loading
		const maxScrolls = 12
		for (let i = 0; i < maxScrolls; i++) {
			await page.evaluate(() => { window.scrollBy(0, window.innerHeight) })
			await page.waitForTimeout(1200)
		}
		// Ensure event anchors present if possible
		try { await page.waitForSelector('a.event-link, li.event-listings-element', { timeout: 15_000 }) } catch {}

		// Try multiple selectors
		const selectors = [
			'li.event-listings-element',
			'.event-listings li',
			'.event-listings .event',
			"[data-testid='event-item']",
			'.event-item',
			'ul.event-listings > li',
			'li.component.events-listings-element'
		]
		let hasAny = false
		for (const sel of selectors) {
			try {
				if (DEBUG) console.error('[songkick] Waiting for selector:', sel)
				await page.waitForSelector(sel, { timeout: 10_000 })
				hasAny = true
				break
			} catch (e) {
				if (DEBUG) console.error('[songkick] Selector not found yet:', sel)
			}
		}

		const html = await page.content()
		if (!html || html.length < 1000) {
			if (DEBUG) console.error('[songkick] Page content too short, returning empty set')
			await browser.close()
			return []
		}

		// Extract with page.evaluate to avoid server libs
		if (DEBUG) console.error('[songkick] Extracting events…')
		let events = await page.evaluate(({ lat, lon, radiusKm, BASE_URL }) => {
			function text(el) { return (el?.textContent || '').trim() }
			function toKm(a, b) {
				// Approx calc (not exact geodesic):
				const R = 6371
				const dLat = (b.lat - a.lat) * Math.PI / 180
				const dLon = (b.lon - a.lon) * Math.PI / 180
				const sindLat = Math.sin(dLat/2)
				const sindLon = Math.sin(dLon/2)
				const va = sindLat*sindLat + Math.cos(a.lat*Math.PI/180) * Math.cos(b.lat*Math.PI/180) * sindLon*sindLon
				const c = 2 * Math.atan2(Math.sqrt(va), Math.sqrt(1-va))
				return R * c
			}

			// Fallback: parse JSON-LD event data if present (AMP pages etc.)
			try {
				const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
				  .map(s => { try { return JSON.parse(s.textContent || 'null') } catch { return null } })
				  .filter(Boolean)
				let ldEvents = []
				for (const item of ld) {
					const arr = Array.isArray(item) ? item : [item]
					for (const obj of arr) {
						if (obj['@type'] === 'Event' || (obj['@graph'] && obj['@graph'].some(x => x['@type'] === 'Event'))) {
							const eventsIn = obj['@graph']?.filter(x => x['@type'] === 'Event') || [obj]
							for (const ev of eventsIn) {
								const name = ev.name || ''
								const date = (ev.startDate || '').slice(0,10)
								const venueName = ev.location?.name || ''
								const url = ev.url || ''
								const geo = ev.location?.geo || {}
								const evLat = geo.latitude ?? null
								const evLon = geo.longitude ?? null
								if (evLat != null && evLon != null) {
									const distance = toKm({ lat, lon }, { lat: evLat, lon: evLon })
									if (distance <= radiusKm) {
										ldEvents.push({ nombre: name, fecha: date, lugar: venueName, enlace: url.startsWith('http') ? url : (BASE_URL + url), latitude: evLat, longitude: evLon, distance_km: Math.round(distance * 100) / 100 })
									}
								} else {
									// No geo; still include for metro area pages
									ldEvents.push({ nombre: name, fecha: date, lugar: venueName, enlace: url.startsWith('http') ? url : (BASE_URL + url) })
								}
							}
						}
					}
				}
				if (ldEvents.length) return ldEvents
			} catch {}

			// Primary path: iterate explicit event anchors
			const anchors = Array.from(document.querySelectorAll('a.event-link[href^="/concerts/"]'))
			const out = []
			for (const a of anchors) {
				try {
					const root = a.closest('li.event-listings-element, .event-listings li, .event, .event-item, article') || a.parentElement || a

					// Date from datetime attribute near the anchor
					const time = root.querySelector('time[datetime], [itemprop="startDate"][content], time')
					let fecha = time?.getAttribute('datetime') || time?.getAttribute('content') || ''
					if (!fecha) {
						const tText = text(time)
						const m = (tText || '').match(/\d{4}-\d{2}-\d{2}|\b(?:\d{1,2} [A-Za-z]{3,9} \d{4})\b/)
						fecha = m ? (m[0].length === 10 ? m[0] : '') : ''
					}
					if (fecha.length > 10) fecha = fecha.slice(0, 10)

					// Title/artist from the anchor strong
					const strong = a.querySelector('span > strong') || root.querySelector('strong, h2, h3, [itemprop="name"]')
					const nombre = text(strong)

					// Venue anchor near the anchor
					const venueEl = root.querySelector('a.venue-link, a[href*="/venues/"]') || root.querySelector('.venue, .location, [itemprop="location"], [data-qa="event-venue"]')
					const venue = text(venueEl)

					// Link from the event anchor
					const href = a.getAttribute('href')
					const enlace = href ? (href.startsWith('http') ? href : `${BASE_URL}${href}`) : ''

					// Geo
					let evLat = null, evLon = null
					const microformat = root.querySelector('div.microformat script[type="application/ld+json"]')
					if (microformat?.textContent) {
						try {
							const data = JSON.parse(microformat.textContent)
							const obj = Array.isArray(data) ? data[0] : data
							const geo = obj?.location?.geo || {}
							evLat = geo?.latitude ?? null
							evLon = geo?.longitude ?? null
						} catch {}
					}

					if (evLat != null && evLon != null) {
						const distance = toKm({ lat, lon }, { lat: evLat, lon: evLon })
						if (distance > radiusKm) continue
						out.push({ nombre, fecha, lugar: venue, enlace, latitude: evLat, longitude: evLon, distance_km: Math.round(distance * 100) / 100 })
					} else {
						out.push({ nombre, fecha, lugar: venue, enlace })
					}
				} catch {}
			}
			return out
		}, { lat, lon, radiusKm, BASE_URL })

		// Enrich missing fields by visiting event pages (limit concurrency)
		const needEnrichment = Array.isArray(events) ? events
			.filter(ev => (!ev.fecha || !ev.lugar || !ev.enlace) && ev.enlace)
			.slice(0, 15) : []
		const concurrency = 5
		function chunkArray(arr, size) {
			const res = []
			for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size))
			return res
		}
		for (const batch of chunkArray(needEnrichment, concurrency)) {
			await Promise.all(batch.map(async (ev) => {
				try {
					const p2 = await context.newPage()
					await p2.goto(ev.enlace, { waitUntil: 'domcontentloaded', timeout: 45_000 })
					try { await p2.waitForLoadState('networkidle', { timeout: 5_000 }) } catch {}
					const detail = await p2.evaluate(() => {
						function text(el) { return (el?.textContent || '').trim() }
						const out = { fecha: '', lugar: '', enlace: '' }
						try {
							const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
								.map(s => { try { return JSON.parse(s.textContent || 'null') } catch { return null } })
								.filter(Boolean)
							for (const item of ld) {
								const arr = Array.isArray(item) ? item : [item]
								for (const obj of arr) {
									if (obj['@type'] === 'Event') {
										out.fecha = (obj.startDate || '').slice(0,10) || out.fecha
										out.lugar = obj.location?.name || out.lugar
										out.enlace = obj.url || out.enlace
									}
								}
							}
						} catch {}
						// Fallbacks
						if (!out.fecha) {
							const t = document.querySelector('time, [itemprop="startDate"]')
							out.fecha = (t?.getAttribute('datetime') || t?.getAttribute('content') || '').slice(0,10)
						}
						if (!out.lugar) {
							out.lugar = text(document.querySelector('a.venue-link, .venue, .location, [itemprop="location"]'))
						}
						if (!out.enlace) {
							out.enlace = location.href
						}
						return out
					})
					await p2.close()
					ev.fecha = ev.fecha || detail.fecha
					ev.lugar = ev.lugar || detail.lugar
					ev.enlace = ev.enlace || detail.enlace
				} catch {}
			}))
		}

		const count = Array.isArray(events) ? events.length : 0
		if (DEBUG) console.error('[songkick] Extracted events:', count)
		await browser.close()
		return events
	} catch (e) {
		if (DEBUG) console.error('[songkick] Error:', e?.message || e)
		if (browser) try { await browser.close() } catch {}
		return []
	}
}

// CLI compatibility: node scripts/scrape_songkick.js <lat> <lon> <radius>
// Use robust Windows-friendly detection by normalizing to file URL
import { pathToFileURL } from 'url'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	(async () => {
		const args = process.argv.slice(2)
		const lat = parseFloat(args[0])
		const lon = parseFloat(args[1])
		const radius = parseFloat(args[2] || '50')
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			console.log('[]')
			process.exit(0)
		}
		const events = await scrapeSongkick(lat, lon, radius)
		// Optional file output: --out <path> or --out=<path> or env SAVE_EVENTS_JSON
		let outPath = ''
		const envOut = process.env.SAVE_EVENTS_JSON
		if (envOut && envOut.trim()) outPath = envOut.trim()
		for (let i = 3; i < args.length; i++) {
			const a = args[i]
			if (!a) continue
			if (a === '--out' && args[i+1]) { outPath = args[i+1]; break }
			if (a.startsWith('--out=')) { outPath = a.slice(6); break }
		}
		if (outPath) {
			try {
				const abs = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath)
				fs.mkdirSync(path.dirname(abs), { recursive: true })
				fs.writeFileSync(abs, JSON.stringify(events, null, 2), 'utf8')
				if (String(process.env.DEBUG||'').toLowerCase()==='true') console.error('[songkick] Saved events to', abs)
			} catch (e) {
				if (String(process.env.DEBUG||'').toLowerCase()==='true') console.error('[songkick] Failed to save events:', e?.message||e)
			}
		}
		console.log(JSON.stringify(events))
	})()
}


