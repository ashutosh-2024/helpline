'use strict';

// ---------- Config ----------

const CATEGORIES = {
  hospital: { label: 'Hospitals', icon: '🏥', color: '#dc2626' },
  pharmacy: { label: 'Pharmacies', icon: '💊', color: '#16a34a' },
  police:   { label: 'Police', icon: '🚓', color: '#2563eb' },
  fire:     { label: 'Fire', icon: '🚒', color: '#ea580c' },
  blood:    { label: 'Blood banks', icon: '🩸', color: '#9f1239' },
};

// Public Overpass servers, queried in parallel; the first good answer wins. They are often overloaded,
// so if all fail we fall back to Nominatim, and Google Maps search links are always shown as a last resort.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 8000;

// Nominatim fallback: one request per category, spaced out to respect its 1 request/second policy.
const NOMINATIM_AMENITIES = ['hospital', 'clinic', 'pharmacy', 'police', 'fire_station', 'blood_bank'];
const NOMINATIM_GAP_MS = 1100;

// Widen the search until we find at least a few hospitals.
const RADII = [3000, 8000, 20000];
const MIN_HOSPITALS = 3;

const GMAPS_SEARCHES = [['hospital', '🏥 Hospitals'], ['pharmacy', '💊 Pharmacies'], ['police station', '🚓 Police'], ['fire station', '🚒 Fire'], ['blood bank', '🩸 Blood banks']];
const MAX_LIST = 60;
const CACHE_KEY = 'nhn:last';

// Emergency numbers, guessed from the phone's time zone. 112 works on most mobile networks worldwide.
const NUMBERS = {
  IN: { main: '112', more: [['Ambulance', '108'], ['Police', '100'], ['Fire', '101'], ['Women', '1091'], ['Child', '1098']] },
  US: { main: '911', more: [['Poison', '18002221222']] },
  GB: { main: '999', more: [['NHS 111', '111']] },
  AU: { main: '000', more: [] },
  DEFAULT: { main: '112', more: [] },
};

function detectCountry() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'IN';
  if (tz === 'Europe/London') return 'GB';
  if (tz.startsWith('Australia/')) return 'AU';
  if (/^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Indiana|Kentucky|Toronto|Vancouver|Edmonton|Winnipeg|Halifax|Regina|St_Johns)/.test(tz) || tz.startsWith('US/') || tz === 'Pacific/Honolulu') return 'US';
  return 'DEFAULT';
}

// ---------- DOM ----------

const $ = (id) => document.getElementById(id);
const els = {
  sosCall: $('sosCall'), sosNum: $('sosNum'), quickNums: $('quickNums'),
  findBtn: $('findBtn'), placeForm: $('placeForm'), placeInput: $('placeInput'),
  status: $('status'), filters: $('filters'), map: $('map'), results: $('results'),
  gmaps: $('gmaps'), gmapsLinks: $('gmapsLinks'),
};

const state = { origin: null, places: [], filter: 'all', map: null, layer: null, markers: new Map() };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setStatus(msg, kind = 'info') {
  els.status.hidden = !msg;
  els.status.className = `status ${kind}`;
  els.status.innerHTML = msg || '';
}

// ---------- Emergency numbers ----------

function renderNumbers() {
  const n = NUMBERS[detectCountry()];
  els.sosCall.href = `tel:${n.main}`;
  els.sosNum.textContent = n.main;
  els.quickNums.innerHTML = n.more
    .map(([label, num]) => `<a class="chip-call" href="tel:${num}">${escapeHtml(label)} <b>${num}</b></a>`)
    .join('');
  els.quickNums.hidden = n.more.length === 0;
}

// ---------- Location ----------

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('unsupported'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      reject,
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
}

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);
  const [hit] = await res.json();
  if (!hit) return null;
  return { lat: +hit.lat, lon: +hit.lon, label: hit.display_name };
}

// ---------- Overpass ----------

function buildQuery(lat, lon, radius) {
  const near = `(around:${radius},${lat},${lon})`;
  return `[out:json][timeout:10];(
nwr["amenity"~"^(hospital|clinic|pharmacy|police|fire_station|blood_bank)$"]${near};
nwr["healthcare"~"^(hospital|blood_donation|blood_bank)$"]${near};
);out center tags;`;
}

// Ask every server at once and take the first good answer; cancel the rest.
async function overpass(query) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OVERPASS_TIMEOUT_MS);
  const ask = async (endpoint) => {
    const res = await fetch(endpoint, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // A server that ran out of time answers 200 with a "remark" and no data.
    if (json.remark && !json.elements?.length) throw new Error(json.remark);
    return json.elements || [];
  };
  try {
    return await Promise.any(OVERPASS.map(ask));
  } catch {
    throw new Error('map servers busy');
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

// ---------- Nominatim (fallback) ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Turn a Nominatim result into the same shape as an Overpass element so toPlaces() handles both.
function fromNominatim(r) {
  const a = r.address || {};
  return {
    type: r.osm_type, id: r.osm_id, lat: +r.lat, lon: +r.lon,
    tags: {
      ...(r.extratags || {}),
      amenity: r.category === 'amenity' ? r.type : undefined,
      name: r.name,
      'addr:housenumber': a.house_number,
      'addr:street': a.road,
      'addr:suburb': a.suburb || a.neighbourhood,
      'addr:city': a.city || a.town || a.village,
    },
  };
}

async function nominatimNearby(origin, radiusM, onProgress) {
  const dLat = radiusM / 111320;
  const dLon = dLat / Math.cos(origin.lat * Math.PI / 180);
  const viewbox = [origin.lon - dLon, origin.lat + dLat, origin.lon + dLon, origin.lat - dLat].map((n) => n.toFixed(5)).join(',');
  const elements = [];
  let ok = 0;
  for (const [i, amenity] of NOMINATIM_AMENITIES.entries()) {
    if (i) await sleep(NOMINATIM_GAP_MS);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&amenity=${amenity}&viewbox=${viewbox}&bounded=1&limit=40&extratags=1&addressdetails=1`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      elements.push(...(await res.json()).map(fromNominatim));
      ok++;
      onProgress(toPlaces(elements, origin));
    } catch {
      // Skip this category; others may still work.
    }
  }
  if (!ok) throw new Error('backup server unreachable');
  return toPlaces(elements, origin);
}

function categorize(t) {
  const a = t.amenity, h = t.healthcare;
  if (a === 'blood_bank' || h === 'blood_donation' || h === 'blood_bank') return 'blood';
  if (a === 'hospital' || a === 'clinic' || h === 'hospital') return 'hospital';
  if (a === 'pharmacy') return 'pharmacy';
  if (a === 'police') return 'police';
  if (a === 'fire_station') return 'fire';
  return null;
}

function firstPhone(t) {
  const raw = t.phone || t['contact:phone'] || t['phone:mobile'] || t['contact:mobile'] || t['emergency:phone'];
  if (!raw) return null;
  const first = raw.split(/[;,/]/)[0].trim();
  const dial = first.replace(/[^\d+]/g, '');
  return dial.length >= 3 ? { display: first, dial } : null;
}

function address(t) {
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  return [street, t['addr:suburb'] || t['addr:neighbourhood'], t['addr:city']].filter(Boolean).join(', ');
}

function distanceM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function toPlaces(elements, origin) {
  const seen = new Set();
  const places = [];
  for (const el of elements) {
    const t = el.tags || {};
    const cat = categorize(t);
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!cat || lat == null) continue;
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push({
      id: key,
      cat,
      name: t.name || t['name:en'] || t.operator || (t.amenity === 'clinic' ? 'Clinic' : CATEGORIES[cat].label.replace(/s$/, '')),
      kind: t.amenity === 'clinic' ? 'Clinic' : null,
      lat, lon,
      dist: distanceM(origin, { lat, lon }),
      phone: firstPhone(t),
      addr: address(t),
      open247: t.opening_hours === '24/7',
      emergency: t.emergency === 'yes',
    });
  }
  return places.sort((a, b) => a.dist - b.dist);
}

// ---------- Search ----------

const hospitalCount = (places) => places.filter((p) => p.cat === 'hospital').length;

async function searchOverpass(origin, where) {
  let places = [];
  for (const radius of RADII) {
    setStatus(`Searching within ${radius / 1000} km${where}…`);
    try {
      places = toPlaces(await overpass(buildQuery(origin.lat, origin.lon, radius)), origin);
    } catch (err) {
      if (places.length) break; // keep what a smaller radius already found
      throw err;
    }
    if (hospitalCount(places) >= MIN_HOSPITALS) break;
  }
  return places;
}

async function searchNominatim(origin, where) {
  setStatus(`Main map server is busy. Using the backup server${where}…`);
  let places = await nominatimNearby(origin, 6000, show);
  if (hospitalCount(places) < MIN_HOSPITALS) {
    setStatus(`Few results close by. Searching wider${where}…`);
    await sleep(NOMINATIM_GAP_MS);
    try {
      places = await nominatimNearby(origin, 20000, show);
    } catch {
      // keep the closer results
    }
  }
  return places;
}

async function searchAround(origin, label) {
  state.origin = origin;
  renderGmaps();
  els.findBtn.disabled = true;
  const where = label ? ` of <b>${escapeHtml(label)}</b>` : '';
  try {
    let places;
    try {
      places = await searchOverpass(origin, where);
    } catch {
      places = await searchNominatim(origin, where);
    }
    saveCache({ origin, label, places, ts: Date.now() });
    setStatus(places.length ? '' : 'Nothing found nearby on the map. Call the emergency number above, or try Google Maps below.', places.length ? 'info' : 'warn');
    show(places);
  } catch {
    const cached = loadCache();
    if (cached?.places?.length) {
      setStatus(`Couldn't reach the map servers. Showing results saved ${ago(cached.ts)}${cached.label ? ` for ${escapeHtml(cached.label)}` : ''}. Or use Google Maps below.`, 'warn');
      state.origin = cached.origin;
      show(cached.places);
    } else {
      setStatus('Couldn\'t reach the map servers. Use the Google Maps buttons below, or call the emergency number above.', 'error');
    }
  } finally {
    els.findBtn.disabled = false;
  }
}

async function findNearMe() {
  setStatus('Getting your location…');
  try {
    const pos = await getPosition();
    await searchAround(pos, null);
  } catch (err) {
    const msg = err.code === 1
      ? 'Location permission was blocked. Allow location for this site in your browser settings, or type your area below.'
      : 'Couldn\'t get your location. Type your area below instead.';
    setStatus(msg, 'warn');
    els.placeInput.focus();
  }
}

async function findByPlace(e) {
  e.preventDefault();
  const q = els.placeInput.value.trim();
  if (!q) return els.placeInput.focus();
  setStatus(`Looking up <b>${escapeHtml(q)}</b>…`);
  try {
    const hit = await geocode(q);
    if (!hit) return setStatus(`Couldn't find "${escapeHtml(q)}". Try a bigger nearby place or city.`, 'warn');
    await searchAround(hit, hit.label.split(',').slice(0, 2).join(','));
  } catch (err) {
    setStatus(`Place search failed: ${escapeHtml(err.message)}`, 'error');
  }
}

// ---------- Cache (last results, for offline) ----------

function saveCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
}
function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; }
}
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// ---------- Rendering ----------

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

function directionsUrl(p) {
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`;
}

// Always-available last resort: let Google Maps do the search around the same point.
function renderGmaps() {
  const { lat, lon } = state.origin;
  els.gmapsLinks.innerHTML = GMAPS_SEARCHES
    .map(([q, label]) => `<a class="chip-call" href="https://www.google.com/maps/search/${encodeURIComponent(q)}/@${lat},${lon},14z" target="_blank" rel="noopener">${label}</a>`)
    .join('');
  els.gmaps.hidden = false;
}

function show(places) {
  state.places = places;
  renderFilters();
  renderList();
  renderMap();
}

function renderFilters() {
  const counts = { all: state.places.length };
  for (const p of state.places) counts[p.cat] = (counts[p.cat] || 0) + 1;
  const tabs = [['all', 'All', '']].concat(Object.entries(CATEGORIES).map(([k, c]) => [k, c.label, c.icon]));
  els.filters.innerHTML = tabs
    .filter(([k]) => k === 'all' || counts[k])
    .map(([k, label, icon]) =>
      `<button role="tab" data-cat="${k}" aria-selected="${state.filter === k}">${icon} ${label} <span>${counts[k] || 0}</span></button>`)
    .join('');
  els.filters.hidden = state.places.length === 0;
  if (state.filter !== 'all' && !counts[state.filter]) state.filter = 'all';
}

function visible() {
  return state.places.filter((p) => state.filter === 'all' || p.cat === state.filter).slice(0, MAX_LIST);
}

function renderList() {
  els.results.innerHTML = visible().map((p) => {
    const c = CATEGORIES[p.cat];
    const badges = [
      p.kind && `<span class="badge">${p.kind}</span>`,
      p.emergency && '<span class="badge red">Emergency</span>',
      p.open247 && '<span class="badge green">24/7</span>',
    ].filter(Boolean).join('');
    return `<li class="place-card" data-id="${p.id}" style="--cat:${c.color}">
      <div class="place-head">
        <span class="place-icon" aria-hidden="true">${c.icon}</span>
        <div class="place-main">
          <h3>${escapeHtml(p.name)}</h3>
          <p class="muted small">${fmtDist(p.dist)}${p.addr ? ` · ${escapeHtml(p.addr)}` : ''}</p>
          ${badges ? `<p class="badges">${badges}</p>` : ''}
        </div>
      </div>
      <div class="place-actions">
        ${p.phone
          ? `<a class="btn call" href="tel:${p.phone.dial}">📞 Call</a>`
          : '<span class="btn disabled" title="No phone number on the map">No number</span>'}
        <a class="btn go" href="${directionsUrl(p)}" target="_blank" rel="noopener">🧭 Directions</a>
        <button class="btn ghost show-map" type="button" aria-label="Show on map">🗺️</button>
      </div>
    </li>`;
  }).join('');
}

function renderMap() {
  if (!window.L || !state.origin) return; // Leaflet not loaded (offline first visit): the list still works.
  els.map.hidden = false;
  if (!state.map) {
    state.map = L.map(els.map, { zoomControl: true, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(state.map);
    state.layer = L.layerGroup().addTo(state.map);
  }
  state.layer.clearLayers();
  state.markers.clear();

  const you = [state.origin.lat, state.origin.lon];
  L.circleMarker(you, { radius: 9, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 })
    .bindPopup('You are here').addTo(state.layer);

  const shown = visible();
  for (const p of shown) {
    const c = CATEGORIES[p.cat];
    const m = L.circleMarker([p.lat, p.lon], { radius: 8, color: '#fff', weight: 2, fillColor: c.color, fillOpacity: 0.95 })
      .bindPopup(`<b>${escapeHtml(p.name)}</b><br>${fmtDist(p.dist)}<br><a href="${directionsUrl(p)}" target="_blank" rel="noopener">Directions</a>${p.phone ? ` · <a href="tel:${p.phone.dial}">Call</a>` : ''}`)
      .addTo(state.layer);
    state.markers.set(p.id, m);
  }

  const nearest = shown.slice(0, 8).map((p) => [p.lat, p.lon]);
  const bounds = L.latLngBounds([you, ...nearest]);
  state.map.invalidateSize();
  state.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
}

// ---------- Events ----------

els.findBtn.addEventListener('click', findNearMe);
els.placeForm.addEventListener('submit', findByPlace);

els.filters.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cat]');
  if (!btn) return;
  state.filter = btn.dataset.cat;
  renderFilters();
  renderList();
  renderMap();
});

els.results.addEventListener('click', (e) => {
  const btn = e.target.closest('.show-map');
  if (!btn || !state.map) return;
  const id = btn.closest('.place-card').dataset.id;
  const m = state.markers.get(id);
  if (!m) return;
  els.map.scrollIntoView({ behavior: 'smooth', block: 'center' });
  state.map.setView(m.getLatLng(), 17);
  m.openPopup();
});

// ---------- Start ----------

renderNumbers();

const cached = loadCache();
if (cached?.places?.length) {
  state.origin = cached.origin;
  renderGmaps();
  setStatus(`Showing results saved ${ago(cached.ts)}${cached.label ? ` for ${escapeHtml(cached.label)}` : ''}. Tap <b>Find help near me</b> to refresh.`);
  show(cached.places);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
