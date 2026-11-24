// Graphiques (Chart.js) aux couleurs du thème.
const charts = new Map();

export function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export const fmtMm = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${v.toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: 0 })} mm`);

function baseOptions() {
  const text2 = css('--text-2'), muted = css('--muted'), grid = css('--grid');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false, labels: { color: text2, boxWidth: 12, boxHeight: 12, usePointStyle: true, pointStyle: 'rectRounded', font: { size: 11 } } },
      tooltip: {
        backgroundColor: css('--surface'), titleColor: css('--text'), bodyColor: text2,
        borderColor: css('--border'), borderWidth: 1, padding: 8, displayColors: true, boxPadding: 4,
        callbacks: { label: (c) => `${c.dataset.label} : ${fmtMm(c.parsed.y)}` },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 14, font: { size: 11 } }, border: { color: grid } },
      y: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: muted, font: { size: 11 }, maxTicksLimit: 5, callback: (v) => `${v}` }, title: { display: true, text: 'mm', color: muted, font: { size: 11 } } },
    },
  };
}

function merge(a, b) {
  for (const k of Object.keys(b)) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && typeof b[k] !== 'function' && a[k] && typeof a[k] === 'object') merge(a[k], b[k]);
    else a[k] = b[k];
  }
  return a;
}

export function render(id, { type = 'bar', labels, datasets, options = {} }) {
  const el = document.getElementById(id);
  if (!el || !window.Chart) return null;
  charts.get(id)?.destroy();
  const ch = new window.Chart(el, { type, data: { labels, datasets }, options: merge(baseOptions(), options) });
  charts.set(id, ch);
  return ch;
}

export function barDataset(label, data, color, extra = {}) {
  return {
    type: 'bar', label, data, backgroundColor: color, hoverBackgroundColor: color,
    borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom',
    categoryPercentage: 0.9, barPercentage: 0.9, maxBarThickness: 28, order: 2, ...extra,
  };
}

export function lineDataset(label, data, color, extra = {}) {
  return {
    type: 'line', label, data, borderColor: color, backgroundColor: color,
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 10, tension: 0.15, order: 1, spanGaps: true, ...extra,
  };
}

/** Re-render après changement de thème. */
export function onThemeChange(cb) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', cb);
}
