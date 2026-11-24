// Carte Leaflet : fond OpenStreetMap, marqueur du lieu, radar RainViewer animé.
import { fetchRadarFrames } from './api.js';

let map, marker, baseLayer, radarLayers = [], radarFrames = [], radarHost = '', radarIdx = 0, timer = null;
let activeLayer = 'radar';
let onPick = () => {};

function setBase() {
  // En mode sombre, les tuiles sont assombries par un filtre CSS (.basemap) défini dans app.css.
  baseLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'basemap',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>',
  }).addTo(map);
}

export function initMap(el, { lat, lon, onPickPoint }) {
  onPick = onPickPoint;
  map = L.map(el, { zoomControl: false, attributionControl: true }).setView([lat ?? 46.6, lon ?? 2.4], lat ? 9 : 5);
  setBase();
  map.on('click', (e) => onPick(e.latlng.lat, e.latlng.lng));
  setupRadarControls();
  loadRadar();
  setInterval(loadRadar, 5 * 60 * 1000);
  return map;
}

export function invalidate() { map?.invalidateSize(); }

export function setMarker(lat, lon, fly = true) {
  if (!map) return;
  const icon = L.divIcon({ className: '', html: '<div class="pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  if (!marker) marker = L.marker([lat, lon], { icon, keyboard: false }).addTo(map);
  else marker.setLatLng([lat, lon]);
  if (fly) map.setView([lat, lon], Math.max(map.getZoom(), 8));
}

// ---------- Radar ----------
async function loadRadar() {
  try {
    const { host, frames } = await fetchRadarFrames();
    radarHost = host;
    const newest = frames.at(-1)?.path;
    if (newest && newest === radarFrames.at(-1)?.path) return;
    radarLayers.forEach((l) => map.removeLayer(l));
    radarFrames = frames;
    radarLayers = frames.map((f) => L.tileLayer(`${radarHost}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      opacity: 0, maxNativeZoom: 7, maxZoom: 19, zIndex: 10,
      attribution: '<a href="https://www.rainviewer.com/">RainViewer</a>',
    }));
    const slider = document.getElementById('radarSlider');
    slider.max = Math.max(0, frames.length - 1);
    showFrame(frames.length - 1);
  } catch {
    document.getElementById('radarTime').textContent = 'Radar indisponible';
  }
}

function showFrame(i) {
  if (!radarLayers.length) return;
  radarIdx = (i + radarLayers.length) % radarLayers.length;
  radarLayers.forEach((l, k) => {
    if (activeLayer !== 'radar') { if (map.hasLayer(l)) map.removeLayer(l); return; }
    if (!map.hasLayer(l)) l.addTo(map);
    l.setOpacity(k === radarIdx ? 0.75 : 0);
  });
  document.getElementById('radarSlider').value = radarIdx;
  const t = new Date(radarFrames[radarIdx].time * 1000);
  document.getElementById('radarTime').textContent = t.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    + (radarIdx === radarLayers.length - 1 ? ' (dernier)' : '');
}

function setupRadarControls() {
  const play = document.getElementById('radarPlay');
  const slider = document.getElementById('radarSlider');
  play.addEventListener('click', () => {
    if (timer) { clearInterval(timer); timer = null; play.textContent = '▶'; play.setAttribute('aria-label', 'Lecture'); return; }
    play.textContent = '❚❚'; play.setAttribute('aria-label', 'Pause');
    timer = setInterval(() => showFrame(radarIdx + 1), 700);
  });
  slider.addEventListener('input', () => showFrame(+slider.value));
  document.querySelectorAll('.map-panel [data-layer]').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    activeLayer = b.dataset.layer;
    document.querySelectorAll('.map-panel [data-layer]').forEach((x) => x.classList.toggle('is-on', x === b));
    document.getElementById('radarCtl').hidden = activeLayer !== 'radar';
    if (activeLayer !== 'radar' && timer) play.click();
    showFrame(radarIdx);
  }));
}
