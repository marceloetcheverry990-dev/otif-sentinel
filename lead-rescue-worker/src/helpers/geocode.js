// src/helpers/geocode.js
// Geocodificación con precisión de casa para Chile.
// OSM/Nominatim suele no tener N° → no alcanza para ruteo del chofer.
// Orden: Mapbox (si hay token) → ArcGIS World Geocoder → Nominatim (solo calle).

const UA = 'OTIF-Sentinel/1.0 (otif@laboratorio-b2b.cl)';

const HOUSE_TYPES = new Set([
  'PointAddress',
  'Subaddress',
  'StreetAddress',
  'address',
]);

function normalizeHouse(n) {
  if (n == null || n === '') return '';
  return String(n).replace(/\s/g, '').toLowerCase();
}

function extractTypedHouseNumber(text) {
  const all = String(text || '').match(/\d{1,6}[A-Za-z]?/g);
  return all && all.length ? all[all.length - 1] : '';
}

/**
 * @returns {Promise<Array<{
 *   display: string,
 *   lat: number,
 *   lng: number,
 *   houseNumber: string,
 *   precision: 'house'|'street'|'place',
 *   provider: string,
 *   score: number
 * }>>}
 */
export async function suggestAddresses(query, env = {}, { limit = 6 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 4) return [];

  const typedHouse = extractTypedHouseNumber(q);
  const results = [];
  const seen = new Set();

  function push(item) {
    if (!item || !Number.isFinite(item.lat) || !Number.isFinite(item.lng)) return;
    const key = `${item.lat.toFixed(5)},${item.lng.toFixed(5)}|${(item.display || '').toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(item);
  }

  // 1) ArcGIS — mejor cobertura de N° de casa en Chile (PointAddress)
  try {
    const url =
      'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?' +
      new URLSearchParams({
        f: 'json',
        SingleLine: /chile/i.test(q) ? q : `${q}, Chile`,
        maxLocations: String(limit),
        outFields: 'Addr_type,Match_addr,AddNum,StName,City,Subregion,Region,Postal,Country',
        forStorage: 'false',
        countryCode: 'CHL',
        langCode: 'es',
      }).toString();
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(7000),
    });
    if (res.ok) {
      const data = await res.json();
      for (const c of data.candidates || []) {
        const attrs = c.attributes || {};
        const addNum = attrs.AddNum ? String(attrs.AddNum) : '';
        const addrType = attrs.Addr_type || '';
        let precision = 'place';
        if (HOUSE_TYPES.has(addrType) && addNum) precision = 'house';
        else if (addrType === 'StreetName' || addrType === 'StreetAddress' || addrType === 'StreetInt') {
          precision = addNum ? 'house' : 'street';
        }
        push({
          display: c.address || attrs.Match_addr || q,
          lat: Number(c.location?.y),
          lng: Number(c.location?.x),
          houseNumber: addNum,
          precision,
          provider: 'arcgis',
          score: typeof c.score === 'number' ? c.score : 0,
        });
      }
    }
  } catch (e) {
    console.warn('[geocode] arcgis suggest:', e.message);
  }

  // 2) Mapbox (si hay token) — refuerzo / alternativas
  const mapboxToken = env.MAPBOX_TOKEN || env.MAPBOX_ACCESS_TOKEN || '';
  if (mapboxToken) {
    try {
      const url =
        'https://api.mapbox.com/geocoding/v5/mapbox.places/' +
        encodeURIComponent(q) +
        `.json?country=cl&language=es&limit=${limit}&types=address,street,place&access_token=${encodeURIComponent(mapboxToken)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        for (const f of data.features || []) {
          const [lng, lat] = f.center || [];
          const ctx = f.context || [];
          const placeParts = [f.text, ...(ctx.map((c) => c.text).filter(Boolean)), 'Chile'];
          const addrNum = f.address ? String(f.address) : '';
          const isAddress = f.place_type && f.place_type.includes('address');
          const precision = isAddress && addrNum ? 'house' : (f.place_type || []).includes('street') ? 'street' : 'place';
          push({
            display: f.place_name || placeParts.filter(Boolean).join(', '),
            lat: Number(lat),
            lng: Number(lng),
            houseNumber: addrNum,
            precision,
            provider: 'mapbox',
            score: typeof f.relevance === 'number' ? f.relevance * 100 : 50,
          });
        }
      }
    } catch (e) {
      console.warn('[geocode] mapbox suggest:', e.message);
    }
  }

  // 3) Nominatim solo si aún no hay nada (precisión calle)
  if (results.length === 0) {
    try {
      const url =
        'https://nominatim.openstreetmap.org/search?' +
        new URLSearchParams({
          q: /chile/i.test(q) ? q : `${q}, Chile`,
          format: 'json',
          addressdetails: '1',
          limit: String(Math.min(limit, 5)),
          countrycodes: 'cl',
        }).toString();
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'es' },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = await res.json();
        for (const item of data || []) {
          const hn = item.address?.house_number ? String(item.address.house_number) : '';
          push({
            display: item.display_name,
            lat: Number(item.lat),
            lng: Number(item.lon),
            houseNumber: hn,
            precision: hn ? 'house' : 'street',
            provider: 'nominatim',
            score: 30,
          });
        }
      }
    } catch (e) {
      console.warn('[geocode] nominatim suggest:', e.message);
    }
  }

  // Ranking: house match del N° pedido > house > street > place; score desc
  results.sort((a, b) => {
    const aMatch = typedHouse && normalizeHouse(a.houseNumber) === normalizeHouse(typedHouse) ? 1 : 0;
    const bMatch = typedHouse && normalizeHouse(b.houseNumber) === normalizeHouse(typedHouse) ? 1 : 0;
    if (bMatch !== aMatch) return bMatch - aMatch;
    const rank = { house: 0, street: 1, place: 2 };
    const ar = rank[a.precision] ?? 3;
    const br = rank[b.precision] ?? 3;
    if (ar !== br) return ar - br;
    return (b.score || 0) - (a.score || 0);
  });

  return results.slice(0, limit);
}

/**
 * Mejor candidato para una dirección (prioridad PointAddress / house).
 * @returns {Promise<null|{lat,lng,display,houseNumber,precision,provider,score}>}
 */
export async function geocodeAddress(query, env = {}) {
  const list = await suggestAddresses(query, env, { limit: 5 });
  if (!list.length) return null;

  const typedHouse = extractTypedHouseNumber(query);
  const houseMatch = typedHouse
    ? list.find((r) => r.precision === 'house' && normalizeHouse(r.houseNumber) === normalizeHouse(typedHouse))
    : null;
  if (houseMatch) return houseMatch;

  const anyHouse = list.find((r) => r.precision === 'house');
  if (anyHouse) return anyHouse;

  const street = list.find((r) => {
    const p = String(r.precision || '').toLowerCase();
    return p === 'street' || p === 'address' || p === 'pointaddress';
  });
  if (street) return street;

  // No devolver centroides de país/ciudad/región: el caller trata found=false
  return null;
}
