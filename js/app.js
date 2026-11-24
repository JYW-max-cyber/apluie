// Apluie — application principale.
import { fetchForecast, fetchHistory, searchPlaces, reverseGeocode, localNow } from './api.js';
import * as S from './stats.js';
import { render, barDataset, lineDataset, css, fmtMm, onThemeChange } from './charts.js';
import { initMap, setMarker, invalidate } from './map.js';

// ---------- État ----------
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(`apluie.${k}`); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`apluie.${k}`, JSON.stringify(v)); } catch { /* */ } },
};

const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const TODAY = todayLocal();
const YESTERDAY = S.addDays(TODAY, -1);

const state = {
  place: null,
  tab: 'forecast',
  hist: { p: '30d', from: S.addDays(YESTERDAY, -59), to: YESTERDAY },
  cum: { p: 'hydro', from: S.seasonStart(YESTERDAY, 'hydro'), to: YESTERDAY },
  base: 'hydro',
  years: [], // [{y, slot}]
  forecast: null,
  recent: null,     // série 92 jours
  history: null,    // { series, eraEnd }
  histError: null,
  fcError: null,
};
let loadToken = 0;

// ---------- Utilitaires ----------
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const fmtDate = (s, withYear = true) => `${+s.slice(8, 10)} ${MONTHS[+s.slice(5, 7) - 1]}${withYear ? ' ' + s.slice(0, 4) : ''}`;
const fmtPct = (v) => (Number.isNaN(v) ? '—' : `${Math.round(v)} %`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SLOTS = ['--s1', '--s2', '--s3', '--s4'];

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function anomalyBadge(pct) {
  if (Number.isNaN(pct)) return '';
  if (pct < 80) return `<span class="badge dry">▼ ${fmtPct(pct)} de la normale</span>`;
  if (pct > 120) return `<span class="badge wet">▲ ${fmtPct(pct)} de la normale</span>`;
  return `<span class="badge">≈ ${fmtPct(pct)} de la normale</span>`;
}

// ---------- URL partageable ----------
function writeHash() {
  if (!state.place) return;
  const p = state.place;
  const h = new URLSearchParams({
    lat: p.lat.toFixed(4), lon: p.lon.toFixed(4), n: p.name, s: p.sub || '', t: state.tab,
    hp: state.hist.p, cp: state.cum.p, b: state.base, y: state.years.map((x) => x.y).join(','),
  });
  if (state.hist.p === 'custom') { h.set('hf', state.hist.from); h.set('ht', state.hist.to); }
  if (state.cum.p === 'custom') { h.set('cf', state.cum.from); h.set('ct', state.cum.to); }
  history.replaceState(null, '', `#${h}`);
}

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const lat = parseFloat(h.get('lat')), lon = parseFloat(h.get('lon'));
  if (h.get('t')) state.tab = h.get('t');
  if (h.get('hp')) state.hist.p = h.get('hp');
  if (h.get('hf') && h.get('ht')) { state.hist.from = h.get('hf'); state.hist.to = h.get('ht'); }
  if (h.get('cp')) state.cum.p = h.get('cp');
  if (h.get('cf') && h.get('ct')) { state.cum.from = h.get('cf'); state.cum.to = h.get('ct'); }
  if (h.get('b')) state.base = h.get('b') === 'civil' ? 'civil' : 'hydro';
  if (h.get('y')) state.years = h.get('y').split(',').filter(Boolean).slice(0, 4).map((y, i) => ({ y: +y, slot: i }));
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, name: h.get('n') || `${lat}, ${lon}`, sub: h.get('s') || '' };
  return null;
}

// ---------- Lieu ----------
function setPlace(place, { fly = true, keepYears = false } = {}) {
  if (!keepYears && !sameP(place, state.place)) state.years = [];
  state.place = place;
  store.set('last', place);
  $('placeName').textContent = place.name;
  $('placeSub').textContent = place.sub || `${place.lat.toFixed(3)}, ${place.lon.toFixed(3)}`;
  updateFavBtn();
  setMarker(place.lat, place.lon, fly);
  writeHash();
  loadData();
}

async function pickPoint(lat, lon) {
  const tmp = { lat, lon, name: 'Point sélectionné', sub: `${lat.toFixed(3)}, ${lon.toFixed(3)}` };
  setPlace(tmp, { fly: false });
  const g = await reverseGeocode(lat, lon);
  if (state.place === tmp) {
    tmp.name = g.name; tmp.sub = g.sub;
    $('placeName').textContent = g.name; $('placeSub').textContent = g.sub;
    store.set('last', tmp); writeHash(); updateFavBtn();
  }
}

function geolocate() {
  if (!navigator.geolocation) { toast('Géolocalisation non disponible'); return; }
  toast('Localisation en cours…', 8000);
  navigator.geolocation.getCurrentPosition(async (pos) => {
    closeSheet();
    const { latitude: lat, longitude: lon } = pos.coords;
    const g = await reverseGeocode(lat, lon);
    $('toast').hidden = true;
    setPlace({ lat, lon, name: g.name, sub: `Ma position · ${g.sub}` });
  }, (err) => {
    toast(err.code === 1 ? 'Accès à la position refusé (réglages du navigateur)' : 'Position introuvable');
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
}

// ---------- Favoris ----------
const favs = () => store.get('favs', []);
const sameP = (a, b) => a && b && Math.abs(a.lat - b.lat) < 1e-3 && Math.abs(a.lon - b.lon) < 1e-3;
function updateFavBtn() {
  const on = favs().some((f) => sameP(f, state.place));
  $('favBtn').setAttribute('aria-pressed', on);
  $('favBtn').setAttribute('aria-label', on ? 'Retirer des favoris' : 'Ajouter aux favoris');
}
function toggleFav() {
  if (!state.place) return;
  let f = favs();
  if (f.some((x) => sameP(x, state.place))) { f = f.filter((x) => !sameP(x, state.place)); toast('Retiré des favoris'); }
  else { f.unshift({ ...state.place }); toast('Ajouté aux favoris'); }
  store.set('favs', f.slice(0, 30));
  updateFavBtn(); renderFavs();
}
function renderFavs() {
  const f = favs();
  $('favList').innerHTML = f.length ? f.map((p, i) => `
    <div class="list-item" role="button" tabindex="0" data-fav="${i}">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" style="color:#eda100"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/></svg>
      <div class="grow"><div class="t">${esc(p.name)}</div><div class="s">${esc(p.sub)}</div></div>
      <button class="del" data-del="${i}" aria-label="Supprimer ${esc(p.name)}">✕</button>
    </div>`).join('') : '<div class="list-empty">Aucun favori. Touchez ☆ en haut pour enregistrer le lieu affiché.</div>';
}

// ---------- Recherche ----------
function openSheet() { $('sheet').hidden = false; renderFavs(); setTimeout(() => $('searchInput').focus(), 50); }
function closeSheet() { $('sheet').hidden = true; }
let searchCtl, searchT;
function onSearch() {
  const q = $('searchInput').value.trim();
  clearTimeout(searchT);
  if (q.length < 2) { $('searchResults').innerHTML = ''; return; }
  searchT = setTimeout(async () => {
    searchCtl?.abort(); searchCtl = new AbortController();
    try {
      const res = await searchPlaces(q, searchCtl.signal);
      onSearch.results = res;
      $('searchResults').innerHTML = res.length ? res.map((r, i) => `
        <button class="list-item" data-res="${i}">
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>
          <div class="grow"><div class="t">${esc(r.name)}</div><div class="s">${esc(r.sub)}</div></div>
        </button>`).join('') : '<div class="list-empty">Aucun résultat</div>';
    } catch (e) {
      if (e.name !== 'AbortError') $('searchResults').innerHTML = '<div class="list-empty">Recherche indisponible (réseau ?)</div>';
    }
  }, 280);
}

// ---------- Chargement des données ----------
function loadData() {
  const { lat, lon } = state.place;
  const token = ++loadToken;
  state.forecast = null; state.recent = null; state.history = null; state.histError = null; state.fcError = null;
  renderCurrent();
  fetchForecast(lat, lon)
    .then((f) => { if (token === loadToken) { state.forecast = f; if (state.tab === 'forecast') renderForecast(); } })
    .catch((e) => { if (token === loadToken) { state.fcError = e.message; if (state.tab === 'forecast') renderForecast(); } });
  fetchHistory(lat, lon, TODAY, (recent) => {
    if (token !== loadToken || state.history) return;
    state.recent = recent;
    if (state.tab === 'history') renderHistory();
  })
    .then((h) => { if (token === loadToken) { state.history = h; initYears(); renderCurrent(); } })
    .catch((e) => { if (token === loadToken) { state.histError = e.message; renderCurrent(); } });
}

// ---------- Onglets ----------
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== tab; });
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-on', t.dataset.tab === tab));
  $('credits').hidden = tab === 'map';
  $('views').scrollTop = 0;
  if (tab === 'map') setTimeout(invalidate, 30);
  writeHash();
  renderCurrent();
}

function renderCurrent() {
  if (!state.place) return;
  if (state.tab === 'forecast') renderForecast();
  else if (state.tab === 'history') renderHistory();
  else if (state.tab === 'analyses') renderAnalyses();
}

// ---------- Prévisions ----------
function renderForecast() {
  const f = state.forecast;
  if (state.fcError) { $('fcHero').innerHTML = `<p class="error">Prévisions indisponibles : ${esc(state.fcError)}</p>`; return; }
  if (!f) { $('fcHero').innerHTML = '<div class="skeleton">Chargement des prévisions…</div>'; return; }
  const now = localNow(f.offset);
  const today = now.slice(0, 10);
  const tomorrow = S.addDays(today, 1);

  // 15 min
  const m = f.minutely;
  const mi = [];
  if (m?.time) {
    for (let i = 0; i < m.time.length; i++) {
      if (m.time[i] >= S.addDays(now.slice(0, 10), 0) + now.slice(10) && mi.length < 24) mi.push(i);
    }
  }
  // fallback si l'heure courante n'est pas trouvée
  const mIdx = mi.length ? mi : (m?.time || []).map((_, i) => i).slice(0, 24);
  const nextRain15 = mIdx.find((i) => (m.precipitation[i] ?? 0) >= 0.1);

  // Horaire
  const h = f.hourly;
  const sumDay = (d) => h.time.reduce((s, t, i) => (t.startsWith(d) ? s + (h.precipitation[i] ?? 0) : s), 0);
  const remainToday = h.time.reduce((s, t, i) => (t.startsWith(today) && t >= now.slice(0, 13) ? s + (h.precipitation[i] ?? 0) : s), 0);
  const probAt = (t) => { const k = f.prob.time.indexOf(t); return k >= 0 ? f.prob.precipitation_probability[k] : null; };
  const nextRainH = h.time.findIndex((t, i) => t >= now.slice(0, 13) && (h.precipitation[i] ?? 0) >= 0.2);
  const todayTotal = sumDay(today), tomTotal = sumDay(tomorrow);
  const maxProb = Math.max(...f.prob.time.map((t, i) => (t.startsWith(today) ? f.prob.precipitation_probability[i] ?? 0 : 0)));

  let lead;
  if (nextRain15 !== undefined) {
    const t = m.time[nextRain15];
    lead = t <= now ? 'Il pleut en ce moment.' : `Pluie attendue vers <strong>${t.slice(11, 16)}</strong>.`;
  } else if (nextRainH >= 0) {
    const t = h.time[nextRainH];
    lead = `Pas de pluie dans les prochaines heures. Prochaine pluie : <strong>${t.startsWith(today) ? "aujourd'hui" : t.startsWith(tomorrow) ? 'demain' : fmtDate(t.slice(0, 10), false)} vers ${t.slice(11, 13)} h</strong>.`;
  } else lead = 'Pas de pluie prévue aujourd’hui ni demain.';

  $('fcHero').innerHTML = `
    <div class="muted small">Aujourd'hui, ${fmtDate(today)}</div>
    <div class="big">${todayTotal.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}<small>mm prévus</small></div>
    <div class="lead">${lead}</div>
    <div class="kpis">
      <div class="kpi"><div class="v">${fmtMm(remainToday)}</div><div class="l">d'ici ce soir</div></div>
      <div class="kpi"><div class="v">${fmtMm(tomTotal)}</div><div class="l">demain</div></div>
      <div class="kpi"><div class="v">${Number.isFinite(maxProb) ? maxProb + ' %' : '—'}</div><div class="l">risque max. aujourd'hui</div></div>
    </div>
    <div class="meta">Modèle : ${f.model} · heure locale ${now.slice(11, 16)}</div>`;

  const rain = css('--rain'), soft = css('--rain-soft');
  $('fcNowSrc').textContent = '· mm par 15 min';
  render('chNow', {
    labels: mIdx.map((i) => m.time[i].slice(11, 16)),
    datasets: [barDataset('Pluie (15 min)', mIdx.map((i) => m.precipitation[i] ?? 0), rain)],
    options: { scales: { y: { suggestedMax: 1 } } },
  });

  const hIdx = h.time.map((_, i) => i);
  render('chHourly', {
    labels: h.time.map((t) => (t.startsWith(today) ? '' : 'D ') + t.slice(11, 13) + 'h'),
    datasets: [barDataset('Pluie (heure)', hIdx.map((i) => h.precipitation[i] ?? 0),
      hIdx.map((i) => (h.time[i] < now.slice(0, 13) ? soft : rain)))],
    options: {
      scales: { y: { suggestedMax: 2 }, x: { ticks: { maxTicksLimit: 9 } } },
      plugins: { tooltip: { callbacks: {
        title: (c) => { const t = h.time[c[0].dataIndex]; return `${t.startsWith(today) ? "Aujourd'hui" : 'Demain'} ${t.slice(11, 16)}`; },
        afterLabel: (c) => { const p = probAt(h.time[c.dataIndex]); return p === null ? '' : `Probabilité : ${p} %`; },
      } } },
    },
  });
  $('fcHourlyNote').textContent = 'Barres claires : heures déjà écoulées. « D » = demain. Probabilité dans l’infobulle (ensemble de modèles).';

  const d = f.daily;
  render('chDaily', {
    labels: d.time.map((t, i) => (i === 0 ? "Auj." : new Date(t + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }))),
    datasets: [barDataset('Pluie (jour)', d.precipitation_sum.map((v) => v ?? 0), rain)],
    options: { plugins: { tooltip: { callbacks: { afterLabel: (c) => `Probabilité max. : ${d.precipitation_probability_max[c.dataIndex] ?? '—'} %` } } } },
  });
}

// ---------- Historique ----------
function histRange(series) {
  const end = YESTERDAY;
  const p = state.hist.p;
  const map = { '7d': 6, '30d': 29, '90d': 89, '1y': 364 };
  if (map[p] !== undefined) return [S.addDays(end, -map[p]), end];
  if (p === '5y') return [S.shiftYear(S.addDays(end, 1), -5), end];
  if (p === '30y') return [`${S.yearOf(end) - 30}-01-01`, end];
  if (p === 'all') return [series ? series.start : '1940-01-01', end];
  return [state.hist.from, state.hist.to];
}

function pickUnit(a, b) {
  const n = S.diffDays(a, b) + 1;
  if (n <= 92) return 'day';
  if (n <= 400) return 'week';
  if (n <= 366 * 12) return 'month';
  return 'year';
}

function renderHistory() {
  const full = state.history;
  const series = full?.series || state.recent;
  const [a, b] = histRange(full?.series);
  const needsArchive = S.toMs(a) < S.toMs(S.addDays(TODAY, -91));
  if (state.histError && !series) { $('histSummary').innerHTML = `<p class="error">Historique indisponible : ${esc(state.histError)}</p>`; return; }
  if (!series || (needsArchive && !full)) {
    $('histSummary').innerHTML = '<div class="skeleton">Chargement de l’historique depuis 1940…</div>';
    render('chHist', { labels: [], datasets: [] }); render('chHistCum', { labels: [], datasets: [] });
    return;
  }
  const unit = pickUnit(a, b);
  const agg = S.aggregate(series, a, b, unit);
  const r = S.sumRange(series, a, b);
  const span = S.diffDays(a, b) + 1;
  const rain = css('--rain'), normalC = css('--normal');

  // Résumé
  let normalLine = '';
  let ws = null;
  if (full && span <= 366) {
    ws = S.windowStats(full.series, a, b);
    normalLine = `<div class="cum-detail">Normale 1991-2020 sur la même période : <strong>${fmtMm(ws.normal, 0)}</strong>${ws.nYears ? ` · ${ws.rankDry}<sup>e</sup> plus sec sur ${ws.nYears + 1} ans` : ''}</div>`;
  } else if (full) {
    const years = span / 365.25;
    const an = S.annualNormal(full.series);
    normalLine = `<div class="cum-detail">Moyenne : <strong>${fmtMm(r.sum / years, 0)}/an</strong> · normale 1991-2020 : ${fmtMm(an, 0)}/an</div>`;
  } else normalLine = '<div class="cum-detail muted">Normales en cours de chargement…</div>';

  $('histSummary').innerHTML = `
    <div class="muted small">Du ${fmtDate(a)} au ${fmtDate(b)}</div>
    <div class="cum-line"><span class="big">${fmtMm(r.sum, 0)}</span>${ws ? anomalyBadge(ws.pct) : ''}</div>
    ${normalLine}
    <div class="kpis">
      <div class="kpi"><div class="v">${r.rainy.toLocaleString('fr-FR')}</div><div class="l">jours ≥ 1 mm</div></div>
      <div class="kpi"><div class="v">${fmtMm(r.max, 0)}</div><div class="l">max. journalier</div></div>
      <div class="kpi"><div class="v">${r.maxDate ? fmtDate(r.maxDate, span > 300) : '—'}</div><div class="l">date du max.</div></div>
    </div>`;

  // Graphique principal
  const unitLabel = { day: 'par jour', week: 'par semaine', month: 'par mois', year: 'par an' }[unit];
  $('histTitle').textContent = `Pluie ${unitLabel}`;
  const labels = agg.map((x) => {
    if (unit === 'day') return fmtDate(x.a, false);
    if (unit === 'week') return fmtDate(x.a, false);
    if (unit === 'month') return `${MONTHS[+x.a.slice(5, 7) - 1]} ${x.a.slice(2, 4)}`;
    return x.a.slice(0, 4);
  });
  const datasets = [barDataset(`Pluie ${unitLabel}`, agg.map((x) => x.v), rain)];
  if (full && unit === 'month') {
    const mn = S.monthlyNormals(full.series);
    datasets.push(lineDataset('Normale 1991-2020', agg.map((x) => mn[+x.a.slice(5, 7) - 1]), normalC, { borderDash: [5, 4], stepped: 'middle' }));
  } else if (full && unit === 'year') {
    const an = S.annualNormal(full.series);
    datasets.push(lineDataset('Normale 1991-2020', agg.map(() => an), normalC, { borderDash: [5, 4] }));
  }
  render('chHist', {
    labels, datasets,
    options: {
      plugins: {
        legend: { display: datasets.length > 1 },
        tooltip: { callbacks: { title: (c) => { const x = agg[c[0].dataIndex]; return x.a === x.b ? fmtDate(x.a) : `${fmtDate(x.a)} – ${fmtDate(x.b)}${x.partial ? ' (partiel)' : ''}`; } } },
      },
    },
  });
  const prov = full?.series.provisionalFrom || null;
  $('histNote').textContent = full
    ? `Source : réanalyse ERA5 (ECMWF, ~25 km)${prov && S.toMs(prov) <= S.toMs(b) ? `, complétée à partir du ${fmtDate(prov, false)} par les analyses de modèles (provisoire)` : ''}. Valeurs de grille, pas une mesure de station.`
    : 'Données récentes (analyses de modèles). L’historique complet se charge…';

  // Cumul vs normale
  const showCum = span <= 366 && full;
  $('histCumCard').hidden = !showCum;
  if (showCum) {
    const cur = S.cumulFrom(full.series, a, span, true);
    const nor = S.normalCumulative(full.series, a, b);
    const days = Array.from({ length: span }, (_, i) => S.addDays(a, i));
    render('chHistCum', {
      type: 'line',
      labels: days.map((d) => fmtDate(d, false)),
      datasets: [
        lineDataset('Cumul observé', cur, rain),
        lineDataset('Cumul normal', nor || [], normalC, { borderDash: [5, 4] }),
      ],
      options: { plugins: { legend: { display: true } }, scales: { x: { ticks: { maxTicksLimit: 6 } } } },
    });
  }
}

// ---------- Analyses ----------
function cumRange() {
  const end = YESTERDAY;
  switch (state.cum.p) {
    case '30d': return [S.addDays(end, -29), end];
    case '90d': return [S.addDays(end, -89), end];
    case '180d': return [S.addDays(end, -179), end];
    case 'hydro': return [S.seasonStart(end, 'hydro'), end];
    case 'ytd': return [S.seasonStart(end, 'civil'), end];
    default: return [state.cum.from, state.cum.to];
  }
}

function initYears() {
  if (state.years.length || !state.history) return;
  const cur = S.yearOf(S.seasonStart(YESTERDAY, state.base));
  const totals = S.seasonTotals(state.history.series, state.base);
  const driest = [...totals].sort((x, y) => x.sum - y.sum)[0];
  state.years = [{ y: cur, slot: 0 }, { y: cur - 1, slot: 1 }];
  if (driest && driest.year !== cur - 1) state.years.push({ y: driest.year, slot: 2 });
  writeHash();
}

function addYear(y) {
  if (state.years.some((x) => x.y === y)) return;
  if (state.years.length >= 4) { toast('4 années au maximum : retirez-en une'); return; }
  const used = new Set(state.years.map((x) => x.slot));
  state.years.push({ y, slot: [0, 1, 2, 3].find((s) => !used.has(s)) });
  writeHash(); renderYears();
}

function renderAnalyses() {
  const full = state.history;
  if (state.histError) { $('cumResult').innerHTML = `<p class="error">Historique indisponible : ${esc(state.histError)}</p>`; return; }
  if (!full) { $('cumResult').innerHTML = '<div class="skeleton">Chargement de l’historique depuis 1940…</div>'; return; }
  renderCumul(); renderYears(); renderMonths();
}

function renderCumul() {
  const s = state.history.series;
  const [a, b] = cumRange();
  if (S.toMs(a) > S.toMs(b)) { $('cumResult').innerHTML = '<p class="error">Période invalide.</p>'; return; }
  if (S.diffDays(a, b) > 366 * 3) { $('cumResult').innerHTML = '<p class="error">Période limitée à 3 ans pour la comparaison inter-annuelle.</p>'; return; }
  const ws = S.windowStats(s, a, b);
  const rankTxt = ws.nYears ? (ws.rankDry <= ws.nYears / 2
    ? `${ws.rankDry}<sup>e</sup> plus sec sur ${ws.nYears + 1} ans`
    : `${ws.nYears + 2 - ws.rankDry}<sup>e</sup> plus humide sur ${ws.nYears + 1} ans`) : '';
  $('cumResult').innerHTML = `
    <div class="muted small">Du ${fmtDate(a)} au ${fmtDate(b)} (${S.diffDays(a, b) + 1} jours)</div>
    <div class="cum-line"><span class="big">${fmtMm(ws.current.sum, 0)}</span>${anomalyBadge(ws.pct)}</div>
    <div class="cum-detail">Normale 1991-2020 : <strong>${fmtMm(ws.normal, 0)}</strong> · année sèche (P10) &lt; ${fmtMm(ws.p10, 0)} · humide (P90) &gt; ${fmtMm(ws.p90, 0)}</div>
    <div class="cum-detail">${rankTxt}${ws.current.complete ? '' : ' · <span class="error">données incomplètes</span>'}</div>`;

  const accent = css('--rain'), soft = css('--rain-soft'), normalC = css('--normal');
  render('chCumYears', {
    labels: ws.years.map((y) => String(y.year)),
    datasets: [
      barDataset('Cumul', ws.years.map((y) => y.sum), ws.years.map((y) => (y.current ? accent : soft)), { maxBarThickness: 10, categoryPercentage: 1, barPercentage: 0.8 }),
      lineDataset('Normale 1991-2020', ws.years.map(() => ws.normal), normalC, { borderDash: [5, 4], pointHoverRadius: 0 }),
    ],
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { title: (c) => { const y = ws.years[c[0].dataIndex]; return `${fmtDate(y.a)} – ${fmtDate(y.b)}`; } } } },
      scales: { x: { ticks: { maxTicksLimit: 8 } } },
    },
  });
}

function renderYears() {
  const s = state.history.series;
  const base = state.base;
  document.querySelectorAll('[data-base]').forEach((b) => b.classList.toggle('is-on', b.dataset.base === base));
  const totals = S.seasonTotals(s, base);
  const cur = S.yearOf(S.seasonStart(YESTERDAY, base));
  const available = [...totals.map((t) => t.year), cur].filter((v, i, arr) => arr.indexOf(v) === i).sort((x, y) => y - x);
  const tmap = Object.fromEntries(totals.map((t) => [t.year, t.sum]));
  $('yearSelect').innerHTML = '<option value="">+ Ajouter une année…</option>' + available
    .map((y) => `<option value="${y}">${S.seasonLabel(y, base)}${tmap[y] ? ` — ${Math.round(tmap[y])} mm` : ' (en cours)'}</option>`).join('');

  $('yearChips').innerHTML = state.years.map((x) => `
    <button class="chip year-chip" data-rm="${x.y}" aria-label="Retirer ${S.seasonLabel(x.y, base)}">
      <span class="dot" style="background:${css(SLOTS[x.slot])}"></span>${S.seasonLabel(x.y, base)}${x.y === cur ? ' (en cours)' : ''}<span class="x">✕</span>
    </button>`).join('');

  const sc = S.seasonCurves(s, base, state.years.map((x) => x.y), YESTERDAY);
  const refStart = base === 'hydro' ? '2001-09-01' : '2001-01-01';
  const days = Array.from({ length: 365 }, (_, i) => S.addDays(refStart, i));
  const bandC = css('--band'), normalC = css('--normal');
  const datasets = [
    lineDataset('P10 1991-2020', sc.p10, 'transparent', { pointHoverRadius: 0, order: 5 }),
    lineDataset('P90 1991-2020', sc.p90, 'transparent', { fill: '-1', backgroundColor: bandC, pointHoverRadius: 0, order: 5 }),
    lineDataset('Médiane 1991-2020', sc.p50, normalC, { borderDash: [5, 4], order: 4 }),
  ];
  for (const x of state.years) {
    if (!sc.curves[x.y]) continue;
    datasets.push(lineDataset(S.seasonLabel(x.y, base), sc.curves[x.y], css(SLOTS[x.slot]), { order: 1, borderWidth: x.y === cur ? 2.5 : 2 }));
  }
  render('chYears', {
    type: 'line',
    labels: days.map((d) => fmtDate(d, false)),
    datasets,
    options: {
      plugins: {
        legend: { display: true, labels: { filter: (it) => !it.text.startsWith('P') } },
        tooltip: { filter: (it) => !it.dataset.label.startsWith('P') },
      },
      scales: { x: { ticks: { autoSkip: false, callback: (v, i) => (days[i].endsWith('-01') ? 'JFMAMJJASOND'[+days[i].slice(5, 7) - 1] : null) } } },
    },
  });
}

function renderMonths() {
  const s = state.history.series;
  const mn = S.monthlyNormals(s);
  // 12 derniers mois complets
  const firstOfThis = `${YESTERDAY.slice(0, 7)}-01`;
  const end = S.addDays(firstOfThis, -1);
  const start = `${S.yearOf(end) - (end.slice(5, 7) === '12' ? 0 : 1)}-${String((+end.slice(5, 7) % 12) + 1).padStart(2, '0')}-01`;
  const agg = S.aggregate(s, start, end, 'month');
  const labels = agg.map((x) => `${MONTHS[+x.a.slice(5, 7) - 1]} ${x.a.slice(2, 4)}`);
  const norms = agg.map((x) => mn[+x.a.slice(5, 7) - 1]);
  render('chMonths', {
    labels,
    datasets: [
      barDataset('Pluie du mois', agg.map((x) => x.v), css('--rain')),
      lineDataset('Normale 1991-2020', norms, css('--normal'), { borderDash: [5, 4], stepped: 'middle' }),
    ],
    options: { plugins: { legend: { display: true } } },
  });
  $('monthsTable').innerHTML = `<details><summary>Voir le tableau</summary><table>
    <thead><tr><th>Mois</th><th>Pluie</th><th>Normale</th><th>Écart</th></tr></thead>
    <tbody>${agg.map((x, i) => `<tr><td>${labels[i]}</td><td>${fmtMm(x.v, 0)}</td><td>${fmtMm(norms[i], 0)}</td><td>${x.v === null ? '—' : fmtPct((x.v / norms[i]) * 100)}</td></tr>`).join('')}</tbody>
  </table></details>`;
}

// ---------- Contrôles ----------
function bindChips(containerId, key, customId, fromId, toId, rerender) {
  const c = $(containerId);
  const sync = () => {
    c.querySelectorAll('.chip').forEach((b) => b.classList.toggle('is-on', b.dataset.p === state[key].p));
    $(customId).hidden = state[key].p !== 'custom';
    $(fromId).value = state[key].from; $(toId).value = state[key].to;
    $(fromId).max = YESTERDAY; $(toId).max = YESTERDAY;
  };
  c.addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    state[key].p = b.dataset.p; sync(); writeHash(); rerender();
  });
  const onDate = () => {
    if (!$(fromId).value || !$(toId).value) return;
    state[key].from = $(fromId).value; state[key].to = $(toId).value; writeHash(); rerender();
  };
  $(fromId).addEventListener('change', onDate); $(toId).addEventListener('change', onDate);
  sync();
}

async function share() {
  if (!state.place) return;
  writeHash();
  const url = location.href;
  const title = `Apluie — ${state.place.name}`;
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Lien copié'); } catch { prompt('Copiez ce lien :', url); }
}

function init() {
  $('views').appendChild($('credits'));
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  $('placeBtn').addEventListener('click', openSheet);
  $('favBtn').addEventListener('click', toggleFav);
  $('shareBtn').addEventListener('click', share);
  $('locateBtn').addEventListener('click', geolocate);
  $('geoBtn').addEventListener('click', geolocate);
  $('sheet').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return closeSheet();
    const del = e.target.closest('[data-del]');
    if (del) { const f = favs(); f.splice(+del.dataset.del, 1); store.set('favs', f); renderFavs(); updateFavBtn(); return; }
    const fav = e.target.closest('[data-fav]');
    if (fav) { closeSheet(); setPlace({ ...favs()[+fav.dataset.fav] }); return; }
    const res = e.target.closest('[data-res]');
    if (res) { const r = onSearch.results[+res.dataset.res]; closeSheet(); $('searchInput').value = ''; $('searchResults').innerHTML = ''; setPlace({ lat: r.lat, lon: r.lon, name: r.name, sub: r.sub }); }
  });
  $('searchInput').addEventListener('input', onSearch);
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && onSearch.results?.length) $('searchResults').querySelector('[data-res]')?.click();
    if (e.key === 'Escape') closeSheet();
  });

  bindChips('histChips', 'hist', 'histCustom', 'histFrom', 'histTo', renderHistory);
  bindChips('cumChips', 'cum', 'cumCustom', 'cumFrom', 'cumTo', () => state.history && renderCumul());
  document.querySelectorAll('[data-base]').forEach((b) => b.addEventListener('click', () => {
    if (state.base === b.dataset.base) return;
    state.base = b.dataset.base; state.years = []; initYears(); writeHash(); if (state.history) renderYears();
  }));
  $('yearChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    state.years = state.years.filter((x) => x.y !== +b.dataset.rm); writeHash(); renderYears();
  });
  $('yearSelect').addEventListener('change', (e) => { if (e.target.value) addYear(+e.target.value); e.target.value = ''; });
  const extreme = (dir) => {
    if (!state.history) return;
    const t = S.seasonTotals(state.history.series, state.base).sort((x, y) => dir * (x.sum - y.sum));
    const pick = t.find((x) => !state.years.some((y) => y.y === x.year));
    if (pick) { addYear(pick.year); toast(`${S.seasonLabel(pick.year, state.base)} : ${Math.round(pick.sum)} mm`); }
  };
  $('addDriest').addEventListener('click', () => extreme(1));
  $('addWettest').addEventListener('click', () => extreme(-1));
  onThemeChange(() => renderCurrent());

  const fromHash = readHash();
  const start = fromHash || store.get('last', null);
  initMap($('map'), { lat: start?.lat, lon: start?.lon, onPickPoint: pickPoint });
  if (start) { setTab(fromHash ? state.tab : 'forecast'); setPlace(start, { keepYears: true }); }
  else { setTab('map'); openSheet(); }

  // Lien partagé ouvert alors que l'app est déjà affichée.
  window.addEventListener('hashchange', () => {
    const p = readHash();
    if (p && !sameP(p, state.place)) { setTab(state.tab); setPlace(p, { keepYears: true }); }
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
