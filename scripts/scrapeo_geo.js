export class EventsFetcher {
	constructor(apiKey) {
		this.apiKey = apiKey
		this.baseUrl = 'https://app.ticketmaster.com/discovery/v2/events.json'
	}

	async getEvents({
		city = 'San Diego',
		daysAhead = 30,
		limit = 15,
		latitude = null,
		longitude = null,
		radius = 50,
		countryCode = null
	} = {}) {
		const now = new Date()
		const end = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000)

		const params = new URLSearchParams()
		params.set('apikey', this.apiKey)
		params.set('startDateTime', now.toISOString().split('.')[0] + 'Z')
		params.set('endDateTime', end.toISOString().split('.')[0] + 'Z')
		params.set('sort', 'date,asc')
		params.set('size', String(limit))

		if (countryCode) params.set('countryCode', countryCode)
		if (latitude != null && longitude != null) {
			params.set('latlong', `${latitude},${longitude}`)
			params.set('radius', String(radius))
			params.set('unit', 'km')
		} else if (city) {
			params.set('city', city)
		}

		const url = `${this.baseUrl}?${params.toString()}`
		const res = await fetch(url)
		const data = await res.json()

		const events = []
		if (data?._embedded?.events) {
			for (const event of data._embedded.events) {
				events.push({
					name: event?.name || '',
					url: event?.url || '',
					date: event?.dates?.start?.localDate || '',
					time: event?.dates?.start?.localTime || '',
					venue: event?._embedded?.venues?.[0]?.name || '',
					genre: event?.classifications?.[0]?.genre?.name || '',
					price_range: event?.priceRanges?.[0]
						? `${event.priceRanges[0].min} - ${event.priceRanges[0].max} ${event.priceRanges[0].currency}`
						: 'N/A'
				})
			}
		}
		return events
	}

	async getAllEvents({
		city = 'San Diego',
		daysAhead = 30,
		latitude = null,
		longitude = null,
		radius = 50,
		countryCode = null
	} = {}) {
		const allEvents = []
		let page = 0
		const pageSize = 200 // Maximum page size for Ticketmaster API
		
		while (true) {
			const events = await this.getEvents({
				city,
				daysAhead,
				limit: pageSize,
				latitude,
				longitude,
				radius,
				countryCode
			})
			
			if (events.length === 0) {
				break // No more events
			}
			
			allEvents.push(...events)
			
			// If we got less than pageSize, we've reached the end
			if (events.length < pageSize) {
				break
			}
			
			page++
			
			// Safety limit to prevent infinite loops
			if (page > 50) {
				break
			}
		}
		
		return allEvents
	}
}

export function getHotelCoordinates(hotelName) {
	const hotels = {
		"Grand Hotel Tijuana": [32.5149, -117.0382],
		"Hotel Real del Río": [32.5283, -117.0187],
		"Hotel Pueblo Amigo": [32.5208, -117.0278],
		"Hotel Ticuan": [32.5234, -117.0312],
		"Hotel Lucerna": [32.5267, -117.0256],
		"Hotel Fiesta Inn": [32.5212, -117.0298],
		"Hotel Marriott": [32.5245, -117.0334],
		"Hotel Holiday Inn": [32.5198, -117.0267],
		"Hotel Best Western": [32.5221, -117.0289],
		"Hotel Comfort Inn": [32.5256, -117.0321]
	}
	return hotels[hotelName] || [32.5149, -117.0382]
}

// CLI compatible: node scripts/scrapeo_geo.js <lat> <lon> <radius>
// Use robust Windows-friendly detection by normalizing to file URL
import { pathToFileURL } from 'url'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	(async () => {
		const args = process.argv.slice(2)
		const lat = parseFloat(args[0])
		const lon = parseFloat(args[1])
		const radius = parseFloat(args[2] || '10')
		
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			console.log('[]')
			process.exit(0)
		}

		const apikey = process.env.TICKETMASTER_API_KEY
		if (!apikey) {
			console.log('[]')
			process.exit(0)
		}

		const fetcher = new EventsFetcher(apikey)
		const events = await fetcher.getAllEvents({
			city: null,
			daysAhead: 90, // 90 days ahead
			latitude: lat,
			longitude: lon,
			radius: radius
		})

		// Convert to the expected format for Supabase
		const formattedEvents = events.map(event => ({
			nombre: event.name,
			fecha: event.date,
			lugar: event.venue,
			enlace: event.url,
			// Note: Ticketmaster doesn't provide distance_km, so we'll leave it null
			// The API will handle this
		}))

		console.log(JSON.stringify(formattedEvents))
	})()
}


