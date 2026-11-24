// Accès aux API publiques (V1 : aucune clé requise).
import { makeSeries, mergeSeries } from './stats.js';

/** Emprise approximative de la France métropolitaine + Corse (domaine AROME). */
export function inFrance(lat, lon) {
  return lat > 41.2 && lat < 51.3 && lon > -5.5 && lon < 9.8;
}

async function getJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j.reason) msg = j.reason; } catch { /* */ }
    throw new Error(msg);
  }
  return r.json();
}

const fx = (n) => Number(n).toFixed(4);
const cache = new Map();
function memo(key, fn) {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

/** Heure locale du lieu au format 'YYYY-MM-DDTHH:MM'. */
export function localNow(offsetSec) {
  return new Date(Date.now() + offsetSec * 1000).toISOString().slice(0, 16);
}

// ---------- Prévisions ----------
export function fetchForecast(lat, lon) {
  return memo(`fc:${fx(lat)},${fx(lon)}:${Math.floor(Date.now() / 600000)}`, async () => {
    const fr = inFrance(lat, lon);
    const base = `https://api.open-meteo.com/v1/forecast?latitude=${fx(lat)}&longitude=${fx(lon)}&timezone=auto`;
    const detailQ = '&hourly=precipitation&minutely_15=precipitation&forecast_days=2&forecast_minutely_15=40';
    const detailUrl = fr ? `${base}&models=meteofrance_seamless${detailQ}` : `${base}${detailQ}`;
    const probUrl = `${base}&hourly=precipitation_probability&daily=precipitation_sum,precipitation_probability_max&forecast_days=7`;
    const [detail, prob] = await Promise.all([
      getJSON(detailUrl).catch(() => getJSON(`${base}${detailQ}`)),
      getJSON(probUrl),
    ]);
    return {
      model: fr ? 'Météo-France AROME/ARPEGE' : 'meilleur modèle disponible (Open-Meteo)',
      offset: detail.utc_offset_seconds,
      timezone: detail.timezone,
      minutely: detail.minutely_15,
      hourly: detail.hourly,
      prob: prob.hourly,
      daily: prob.daily,
    };
  });
}

// ---------- Historique ----------
/** Derniers 92 jours (analyses des modèles), disponibles jusqu'à aujourd'hui. */
function fetchRecent(lat, lon) {
  const fr = inFrance(lat, lon);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${fx(lat)}&longitude=${fx(lon)}&timezone=auto`
    + `&daily=precipitation_sum&past_days=92&forecast_days=1${fr ? '&models=meteofrance_seamless' : ''}`;
  return getJSON(url);
}

/** Réanalyse ERA5 (1940 -> ~J-6). */
function fetchArchive(lat, lon, today) {
  const q = `latitude=${fx(lat)}&longitude=${fx(lon)}&start_date=1940-01-01&end_date=${today}&daily=precipitation_sum&timezone=auto`;
  return getJSON(`https://archive-api.open-meteo.com/v1/archive?${q}&models=era5_seamless`)
    .catch(() => getJSON(`https://archive-api.open-meteo.com/v1/archive?${q}`));
}

/**
 * Série quotidienne complète : ERA5 depuis 1940, complétée par les analyses récentes.
 * onRecent(series) est appelé dès que les 92 derniers jours sont disponibles.
 */
export function fetchHistory(lat, lon, today, onRecent) {
  const key = `hist:${fx(lat)},${fx(lon)}:${today}`;
  const recentP = memo(`recent:${key}`, async () => {
    const j = await fetchRecent(lat, lon);
    return { series: makeSeries(j.daily.time, j.daily.precipitation_sum), offset: j.utc_offset_seconds };
  });
  if (onRecent) recentP.then((r) => onRecent(r.series)).catch(() => {});
  return memo(key, async () => {
    const [arch, recent] = await Promise.all([fetchArchive(lat, lon, today), recentP.catch(() => null)]);
    let series = makeSeries(arch.daily.time, arch.daily.precipitation_sum);
    const eraEnd = lastIdx(arch.daily.precipitation_sum, arch.daily.time);
    if (recent) series = mergeSeries(series, recent.series);
    return { series, eraEnd, elevation: arch.elevation };
  });
}

function lastIdx(vals, times) {
  for (let i = vals.length - 1; i >= 0; i--) if (vals[i] !== null) return times[i];
  return null;
}

// ---------- Géocodage ----------
export async function searchPlaces(q, signal) {
  const enc = encodeURIComponent(q);
  const [fr, world] = await Promise.allSettled([
    getJSON(`https://data.geopf.fr/geocodage/search?q=${enc}&type=municipality&limit=6&autocomplete=1`, { signal }),
    getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${enc}&count=8&language=fr&format=json`, { signal }),
  ]);
  const out = [];
  if (fr.status === 'fulfilled') {
    for (const f of fr.value.features || []) {
      const p = f.properties;
      out.push({
        name: p.name || p.label,
        sub: [p.postcode, p.context].filter(Boolean).join(' · '),
        lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], src: 'ign',
      });
    }
  }
  if (world.status === 'fulfilled') {
    for (const r of world.value.results || []) {
      if (r.country_code === 'FR' && out.some((o) => o.src === 'ign' && o.name === r.name && Math.abs(o.lat - r.latitude) < 0.05)) continue;
      out.push({
        name: r.name,
        sub: [r.admin2, r.admin1, r.country].filter(Boolean).join(', '),
        lat: r.latitude, lon: r.longitude, src: 'om',
      });
    }
  }
  if (fr.status === 'rejected' && world.status === 'rejected') throw fr.reason;
  return out.slice(0, 12);
}

export async function reverseGeocode(lat, lon) {
  if (inFrance(lat, lon)) {
    try {
      const j = await getJSON(`https://data.geopf.fr/geocodage/reverse?lat=${fx(lat)}&lon=${fx(lon)}&index=address&limit=1`);
      const p = j.features?.[0]?.properties;
      if (p) return { name: p.city || p.name, sub: [p.postcode, p.context].filter(Boolean).join(' · ') };
    } catch { /* repli ci-dessous */ }
  }
  try {
    const j = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${fx(lat)}&lon=${fx(lon)}&zoom=10&accept-language=fr`);
    const a = j.address || {};
    const name = a.village || a.town || a.city || a.municipality || a.county || j.name;
    if (name) return { name, sub: [a.state, a.country].filter(Boolean).join(', ') };
  } catch { /* */ }
  return { name: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, sub: 'Point sur la carte' };
}

// ---------- Radar ----------
export async function fetchRadarFrames() {
  const j = await getJSON('https://api.rainviewer.com/public/weather-maps.json');
  return { host: j.host, frames: j.radar?.past || [] };
}
