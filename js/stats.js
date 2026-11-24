// Dates (chaînes 'YYYY-MM-DD', calcul en UTC) et statistiques de pluie.

const DAY = 86400000;
export const NORMAL_FROM = 1991;
export const NORMAL_TO = 2020;

export const toMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (s, n) => fromMs(toMs(s) + n * DAY);
export const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);
export const yearOf = (s) => +s.slice(0, 4);
export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Décale une date d'un nombre d'années (29 févr. -> 28 févr. si besoin). */
export function shiftYear(s, dy) {
  const y = yearOf(s) + dy;
  let md = s.slice(5);
  if (md === '02-29' && !isLeap(y)) md = '02-28';
  return `${String(y).padStart(4, '0')}-${md}`;
}

/** Série quotidienne : { start, vals: Float64Array (NaN = manquant), end } */
export function makeSeries(dates, values) {
  const start = dates[0];
  const n = diffDays(start, dates[dates.length - 1]) + 1;
  const vals = new Float64Array(n).fill(NaN);
  for (let i = 0; i < dates.length; i++) {
    const v = values[i];
    if (v !== null && v !== undefined) vals[diffDays(start, dates[i])] = v;
  }
  return { start, vals, end: addDays(start, n - 1) };
}

/** Remplit les jours manquants de `base` (et prolonge) avec `extra`. Retourne aussi la date de 1re valeur provisoire. */
export function mergeSeries(base, extra) {
  const end = toMs(extra.end) > toMs(base.end) ? extra.end : base.end;
  const n = diffDays(base.start, end) + 1;
  const vals = new Float64Array(n).fill(NaN);
  vals.set(base.vals);
  let firstFilled = null;
  for (let i = 0; i < extra.vals.length; i++) {
    const d = addDays(extra.start, i);
    const k = diffDays(base.start, d);
    if (k >= 0 && k < n && Number.isNaN(vals[k]) && !Number.isNaN(extra.vals[i])) {
      vals[k] = extra.vals[i];
      if (!firstFilled) firstFilled = d;
    }
  }
  return { start: base.start, vals, end, provisionalFrom: firstFilled };
}

export function valueAt(series, d) {
  const k = diffDays(series.start, d);
  return k >= 0 && k < series.vals.length ? series.vals[k] : NaN;
}

/** Dernière date avec une valeur. */
export function lastValid(series) {
  for (let i = series.vals.length - 1; i >= 0; i--) if (!Number.isNaN(series.vals[i])) return addDays(series.start, i);
  return null;
}

/** Somme sur [a, b] inclus. complete = >= 95 % des jours présents. */
export function sumRange(series, a, b) {
  const i0 = Math.max(0, diffDays(series.start, a));
  const i1 = Math.min(series.vals.length - 1, diffDays(series.start, b));
  const total = diffDays(a, b) + 1;
  let sum = 0, n = 0, max = 0, maxDate = null, rainy = 0;
  for (let i = i0; i <= i1; i++) {
    const v = series.vals[i];
    if (!Number.isNaN(v)) {
      sum += v; n++;
      if (v >= 1) rainy++;
      if (v > max) { max = v; maxDate = addDays(series.start, i); }
    }
  }
  return { sum, n, total, complete: n >= 0.95 * total, max, maxDate, rainy };
}

const quantile = (sorted, q) => {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

/**
 * Cumul sur [a, b] comparé à la même fenêtre calendaire de toutes les années disponibles.
 * Retourne current, normal (moyenne 1991-2020), rang, percentile, et la liste par année.
 */
export function windowStats(series, a, b) {
  const current = sumRange(series, a, b);
  const endYear = yearOf(b);
  const firstYear = yearOf(series.start);
  const years = [];
  for (let y = firstYear; y <= endYear; y++) {
    const dy = y - endYear;
    const aa = shiftYear(a, dy), bb = shiftYear(b, dy);
    if (toMs(aa) < toMs(series.start)) continue;
    const r = sumRange(series, aa, bb);
    if (r.complete) years.push({ year: y, sum: r.sum, a: aa, b: bb, current: dy === 0 });
  }
  const past = years.filter((y) => !y.current);
  const ref = past.filter((y) => y.year >= NORMAL_FROM && y.year <= NORMAL_TO).map((y) => y.sum);
  const normal = mean(ref);
  const sortedRef = [...ref].sort((x, y) => x - y);
  // Rang : 1 = plus sec de tout l'historique.
  const below = past.filter((y) => y.sum < current.sum).length;
  const rankDry = below + 1;
  return {
    current, normal, years,
    nYears: past.length,
    rankDry,
    pct: normal > 0 ? (current.sum / normal) * 100 : NaN,
    p10: quantile(sortedRef, 0.1), p90: quantile(sortedRef, 0.9),
    percentile: past.length ? (below / past.length) * 100 : NaN,
  };
}

/** Agrège en jour/semaine/mois/année sur [a, b]. Valeur null si période trop incomplète. */
export function aggregate(series, a, b, unit) {
  const out = [];
  if (unit === 'day') {
    for (let d = a; toMs(d) <= toMs(b); d = addDays(d, 1)) {
      const v = valueAt(series, d);
      out.push({ a: d, b: d, v: Number.isNaN(v) ? null : v });
    }
    return out;
  }
  let cur = a;
  while (toMs(cur) <= toMs(b)) {
    let next;
    if (unit === 'week') next = addDays(cur, 6);
    else if (unit === 'month') {
      const y = yearOf(cur), m = +cur.slice(5, 7);
      next = addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1);
    } else next = `${yearOf(cur)}-12-31`;
    const bb = toMs(next) > toMs(b) ? b : next;
    const r = sumRange(series, cur, bb);
    out.push({ a: cur, b: bb, v: r.n >= 0.8 * r.total ? r.sum : null, partial: bb !== next });
    cur = addDays(next, 1);
  }
  return out;
}

/** Normales mensuelles 1991-2020 (mm/mois), index 0 = janvier. */
export function monthlyNormals(series) {
  const sums = Array.from({ length: 12 }, () => []);
  for (let y = NORMAL_FROM; y <= NORMAL_TO; y++) {
    for (let m = 1; m <= 12; m++) {
      const a = `${y}-${String(m).padStart(2, '0')}-01`;
      const b = addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`, -1);
      const r = sumRange(series, a, b);
      if (r.complete) sums[m - 1].push(r.sum);
    }
  }
  return sums.map(mean);
}

/** Normale annuelle 1991-2020. */
export function annualNormal(series) {
  const v = [];
  for (let y = NORMAL_FROM; y <= NORMAL_TO; y++) {
    const r = sumRange(series, `${y}-01-01`, `${y}-12-31`);
    if (r.complete) v.push(r.sum);
  }
  return mean(v);
}

/** Normale quotidienne lissée : cumul normal attendu sur [a, b] jour par jour (moyenne des cumuls 1991-2020). */
export function normalCumulative(series, a, b) {
  const len = diffDays(a, b) + 1;
  const endYear = yearOf(b);
  const curves = [];
  for (let y = NORMAL_FROM; y <= NORMAL_TO; y++) {
    const dy = y - endYear;
    const aa = shiftYear(a, dy);
    const c = cumulFrom(series, aa, len);
    if (c) curves.push(c);
  }
  if (!curves.length) return null;
  const out = new Array(len);
  for (let i = 0; i < len; i++) out[i] = mean(curves.map((c) => c[i]));
  return out;
}

/** Courbe de cumul sur `len` jours depuis `a` (null si trop incomplète). Les manquants comptent 0 mais limités à 5 %. */
export function cumulFrom(series, a, len, allowShort = false) {
  const out = new Array(len);
  let s = 0, miss = 0, lastIdx = -1;
  for (let i = 0; i < len; i++) {
    const v = valueAt(series, addDays(a, i));
    if (Number.isNaN(v)) { miss++; out[i] = null; continue; }
    s += v; out[i] = s; lastIdx = i;
  }
  if (allowShort) {
    // Remplit les trous internes, coupe après la dernière valeur.
    let acc = 0;
    for (let i = 0; i <= lastIdx; i++) { if (out[i] === null) out[i] = acc; else acc = out[i]; }
    return lastIdx >= 0 ? out : null;
  }
  if (miss > 0.05 * len) return null;
  let acc = 0;
  for (let i = 0; i < len; i++) { if (out[i] === null) out[i] = acc; else acc = out[i]; }
  return out;
}

/** Début de l'année (hydrologique : 1er sept., civile : 1er janv.) contenant la date d. */
export function seasonStart(d, base) {
  const y = yearOf(d), m = +d.slice(5, 7);
  if (base === 'hydro') return `${m >= 9 ? y : y - 1}-09-01`;
  return `${y}-01-01`;
}

export function seasonLabel(startYear, base) {
  return base === 'hydro' ? `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}` : `${startYear}`;
}

/** Courbes de cumul par saison + enveloppe 1991-2020 (P10/P50/P90). */
export function seasonCurves(series, base, years, today) {
  const len = 365;
  const res = {};
  for (const y of years) {
    const a = base === 'hydro' ? `${y}-09-01` : `${y}-01-01`;
    const isCurrent = toMs(addDays(a, len)) > toMs(today);
    const c = cumulFrom(series, a, len, isCurrent);
    if (c) res[y] = c;
  }
  const ref = [];
  for (let y = NORMAL_FROM; y <= NORMAL_TO; y++) {
    const a = base === 'hydro' ? `${y}-09-01` : `${y}-01-01`;
    const c = cumulFrom(series, a, len);
    if (c) ref.push(c);
  }
  const p10 = [], p50 = [], p90 = [];
  for (let i = 0; i < len; i++) {
    const col = ref.map((c) => c[i]).sort((x, y) => x - y);
    p10.push(quantile(col, 0.1)); p50.push(quantile(col, 0.5)); p90.push(quantile(col, 0.9));
  }
  return { curves: res, p10, p50, p90, nRef: ref.length };
}

/** Totaux par saison complète (pour trouver la plus sèche / la plus humide). */
export function seasonTotals(series, base) {
  const out = [];
  const y0 = yearOf(series.start) + (base === 'hydro' && series.start.slice(5) > '09-01' ? 1 : 0);
  const last = lastValid(series);
  for (let y = y0; ; y++) {
    const a = base === 'hydro' ? `${y}-09-01` : `${y}-01-01`;
    const b = addDays(base === 'hydro' ? `${y + 1}-09-01` : `${y + 1}-01-01`, -1);
    if (toMs(b) > toMs(last)) break;
    const r = sumRange(series, a, b);
    if (r.complete) out.push({ year: y, sum: r.sum });
  }
  return out;
}
