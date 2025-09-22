// dotenv/config not needed in Vercel - env vars are already available
import { randomUUID } from 'crypto';
const uuidv4 = () => randomUUID();
const uuidValidate = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));

// --- Configuración Amadeus ---
const AMADEUS_CLIENT_ID = process.env.AMADEUS_API_KEY;
const AMADEUS_CLIENT_SECRET = process.env.AMADEUS_API_SECRET;

// Variable global para controlar si Amadeus está disponible
const AMADEUS_AVAILABLE = !!(AMADEUS_CLIENT_ID && AMADEUS_CLIENT_SECRET);

if (!AMADEUS_AVAILABLE) {
  console.error('❌ Faltan las variables de entorno AMADEUS_API_KEY o AMADEUS_API_SECRET');
  console.log('⚠️ Continuando sin búsqueda de hoteles competidores...');
}

// --- Función para obtener token de acceso ---
async function getAccessToken() {
  const url = "https://test.api.amadeus.com/v1/security/oauth2/token";
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  const data = new URLSearchParams({
    "grant_type": "client_credentials",
    "client_id": AMADEUS_CLIENT_ID,
    "client_secret": AMADEUS_CLIENT_SECRET
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: data
    });

    if (!response.ok) {
      throw new Error(`Error obteniendo token: ${await response.text()}`);
    }

    const result = await response.json();
    return result.access_token;
  } catch (error) {
    console.error('❌ Error obteniendo token:', error.message);
    process.exit(1);
  }
}

// --- Función para calcular distancia ---
function calculateDistance(lat1, lon1, lat2, lon2) {
  try {
    // Validar que las coordenadas sean números válidos
    if (![lat1, lon1, lat2, lon2].every(coord => typeof coord === 'number' && !isNaN(coord))) {
      return 0.0;
    }

    // Convertir grados a radianes
    const toRadians = (degrees) => degrees * (Math.PI / 180);
    const lat1Rad = toRadians(lat1);
    const lon1Rad = toRadians(lon1);
    const lat2Rad = toRadians(lat2);
    const lon2Rad = toRadians(lon2);

    // Diferencia de coordenadas
    const dlat = lat2Rad - lat1Rad;
    const dlon = lon2Rad - lon1Rad;

    // Fórmula de Haversine
    const a = Math.sin(dlat/2)**2 + Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dlon/2)**2;
    const c = 2 * Math.asin(Math.sqrt(a));

    // Radio de la Tierra en kilómetros
    const r = 6371;

    const distance = c * r;

    // Asegurar que la distancia sea un número válido
    if (isNaN(distance) || !isFinite(distance)) {
      return 0.0;
    }

    return Math.round(distance * 10) / 10; // Redondear a 1 decimal
  } catch (error) {
    return 0.0;
  }
}

// --- Función para obtener hoteles por geocódigo ---
async function getHotelsByGeocode(lat, lng, token = null, radius = 30, keyword = null) {
  // Si Amadeus no está disponible, devolver array vacío
  if (!AMADEUS_AVAILABLE) {
    return [];
  }
  
  const accessToken = token || await getAccessToken();
  const url = "https://test.api.amadeus.com/v1/reference-data/locations/hotels/by-geocode";
  
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lng.toString(),
    radius: radius.toString()
  });

  try {
    const response = await fetch(`${url}?${params}`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Error en la consulta de hoteles: ${await response.text()}`);
    }

    const data = await response.json();
    
    if (!data.data) {
      throw new Error(`Respuesta inesperada de Amadeus: ${JSON.stringify(data)}`);
    }

    let hotels = data.data;

    // Filtrar por palabra clave si se proporciona
    if (keyword) {
      hotels = hotels.filter(hotel => 
        hotel.name && hotel.name.toLowerCase().includes(keyword.toLowerCase())
      );
    }

    // Limitar resultados para evitar sobrecarga
    hotels = hotels.slice(0, 50);

    // Agregar información de distancia si no está presente
    for (const hotel of hotels) {
      if (hotel.geoCode && hotel.geoCode.latitude && hotel.geoCode.longitude) {
        // Calcular distancia aproximada si no está presente
        if (!hotel.distance) {
          const distance = calculateDistance(
            lat, lng,
            hotel.geoCode.latitude,
            hotel.geoCode.longitude
          );
          // Solo asignar si la distancia es válida
          if (distance > 0) {
            hotel.distance = distance;
          } else {
            hotel.distance = 0.0;
          }
        }
      }
    }

    return hotels;
  } catch (error) {
    console.error('❌ Error obteniendo hoteles:', error.message);
    throw error;
  }
}

// --- Función para guardar hoteles en Supabase ---
async function saveHotelsToSupabase(hotels, userId) {
  if (!uuidValidate(userId)) {
    console.error("❌ user_id inválido");
    return;
  }

  // Importar Supabase solo si está disponible
  let supabase = null;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
    
    if (SUPABASE_URL && SUPABASE_KEY) {
      supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    }
  } catch (error) {
    console.log('⚠️ Supabase no disponible, saltando guardado en base de datos');
  }

  if (!supabase) {
    console.log('⚠️ Supabase no configurado. Saltando guardado en base de datos.');
    return;
  }

  let totalInserted = 0;
  const today = new Date().toISOString().split('T')[0];

  for (const hotel of hotels) {
    try {
      // Try primary table first
      let { error } = await supabase
        .from('hotels_parallel')
        .upsert([
          {
            id: uuidv4(),
            nombre: hotel.name || 'Hotel sin nombre',
            estrellas: hotel.rating || null,
            ubicacion: hotel.address
              ? {
                  cityName: hotel.address.cityName,
                  countryCode: hotel.address.countryCode,
                  postalCode: hotel.address.postalCode,
                  street: hotel.address.lines?.[0] || ''
                }
              : null,
            url: hotel.hotelId ? `https://www.booking.com/hotel/${hotel.hotelId}.html` : null,
            fecha_scrape: today,
            rooms_jsonb: {},
            created_at: new Date().toISOString(),
            ciudad: hotel.address?.cityName || 'Ciudad desconocida',
            distancia: hotel.distance || 0.0
          }
        ], { onConflict: 'nombre,ciudad' })

      // Fallback to legacy table if needed
      if (error) {
        ;({ error } = await supabase
          .from('hoteles_parallel')
          .upsert([
            {
              id: uuidv4(),
              nombre: hotel.name || 'Hotel sin nombre',
              estrellas: hotel.rating || null,
              ubicacion: hotel.address
                ? {
                    cityName: hotel.address.cityName,
                    countryCode: hotel.address.countryCode,
                    postalCode: hotel.address.postalCode,
                    street: hotel.address.lines?.[0] || ''
                  }
                : null,
              url: hotel.hotelId ? `https://www.booking.com/hotel/${hotel.hotelId}.html` : null,
              fecha_scrape: today,
              rooms_jsonb: {},
              created_at: new Date().toISOString(),
              ciudad: hotel.address?.cityName || 'Ciudad desconocida',
              distancia: hotel.distance || 0.0
            }
          ], { onConflict: 'nombre,ciudad' }))
      }

      if (error) {
        console.error("❌ Error guardando hotel:", error.message);
      } else {
        totalInserted++;
        console.log(`✅ ${hotel.name} - ${hotel.address?.cityName || 'N/A'}`);
      }
    } catch (error) {
      console.error(`❌ Error procesando hotel ${hotel.name}:`, error.message);
    }
  }

  console.log(`📊 Total procesados: ${totalInserted} hoteles`);
}

// --- CLI ---
const args = process.argv.slice(2);

if (args.length >= 2) {
  const lat = parseFloat(args[0]);
  const lng = parseFloat(args[1]);
  const radius = parseInt(args.find(arg => arg.startsWith('--radius='))?.split('=')[1]) || 30;
  const keyword = args.find(arg => arg.startsWith('--keyword='))?.split('=')[1] || null;
  const userId = args.find(arg => arg.startsWith('--user-id='))?.split('=')[1] || null;
  const saveToDb = args.includes('--save') || args.includes('-s');

  // Detectar si se está ejecutando desde la API (sin argumentos de guardado)
  const isApiCall = !saveToDb && !userId;

  if (!isApiCall) {
    console.log(`🎯 Configuración:`);
    console.log(`   Latitud: ${lat}`);
    console.log(`   Longitud: ${lng}`);
    console.log(`   Radio: ${radius} km`);
    console.log(`   Palabra clave: ${keyword || 'Ninguna'}`);
    console.log(`   Guardar en DB: ${saveToDb}`);
    console.log(`   User ID: ${userId || 'Ninguno'}`);
  }

  (async () => {
    try {
      if (!isApiCall) {
        console.log('🔍 Buscando hoteles...');
      }
      
      const hotels = await getHotelsByGeocode(lat, lng, null, radius, keyword);
      
      if (!isApiCall) {
        console.log(`✅ Encontrados ${hotels.length} hoteles`);
      }

      if (saveToDb && userId) {
        if (!isApiCall) {
          console.log('💾 Guardando hoteles en base de datos...');
        }
        await saveHotelsToSupabase(hotels, userId);
      } else {
        // Para llamadas de API, solo devolver JSON puro
        console.log(JSON.stringify(hotels, null, 2));
      }

    } catch (error) {
      if (!isApiCall) {
        console.error('❌ Error:', error.message);
      }
      process.exit(1);
    }
    
    // Asegurar que el script termine
    process.exit(0);
  })();
} else {
  console.log("Uso: node amadeus_hotels.js <latitud> <longitud> [opciones]");
  console.log("");
  console.log("Opciones:");
  console.log("  --radius=N              Radio de búsqueda en km (default: 30)");
  console.log("  --keyword=palabra        Filtrar por nombre de hotel");
  console.log("  --user-id=uuid           ID del usuario para guardar en DB");
  console.log("  --save, -s               Guardar resultados en base de datos");
  console.log("");
  console.log("Ejemplos:");
  console.log("  node amadeus_hotels.js 32.5250 -117.0233");
  console.log("  node amadeus_hotels.js 32.5250 -117.0233 --radius=50 --keyword=hilton");
  console.log("  node amadeus_hotels.js 32.5250 -117.0233 --user-id=19609844-eb33-490d-9ead-c8f56f6ed790 --save");
}
