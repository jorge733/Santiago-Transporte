'use strict';

const $ = (sel) => document.querySelector(sel);
const REFRESH_MS = 30000;
const FAV_KEY = 'favoritos';
const STOP_CODE = /^[A-Z]{1,3}\d{1,5}$/;

// Colores oficiales aproximados de las líneas de Metro.
const METRO_COLORS = {
  L1: '#e3051b', L2: '#ffb500', L3: '#7a4a1e', L4: '#0033a0',
  L4A: '#1ba1e2', L5: '#0b9444', L6: '#9b2a94', L7: '#949494',
};

const state = {
  paraderos: null, // [[codigo, nombre, lat, lon, [recorridos]]]
  recorridos: null, // Map recorrido -> {nombre, color, colorTexto}
  currentStop: null,
  refreshTimer: null,
  map: null,
  markers: null,
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function storage(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key)) ?? null;
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return null;
  }
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
  return body;
}

// ---------- Datos estáticos (GTFS preprocesado) ----------

async function loadStaticData() {
  if (state.paraderos) return;
  const [paraderos, recorridos] = await Promise.all([getJson('/data/paraderos.json'), getJson('/data/recorridos.json')]);
  state.paraderos = paraderos;
  state.recorridos = new Map(recorridos.map(([id, nombre, , color, colorTexto]) => [id, { nombre, color, colorTexto }]));
}

const findStop = (codigo) => state.paraderos?.find((p) => p[0] === codigo);

function routeBadge(id) {
  const r = state.recorridos?.get(id);
  const bg = r ? `#${r.color}` : 'var(--accent)';
  const fg = r ? `#${r.colorTexto}` : 'var(--accent-text)';
  return `<span class="badge" style="background:${bg};color:${fg}" title="${escapeHtml(r?.nombre || '')}">${escapeHtml(id)}</span>`;
}

// ---------- Navegación ----------

function route() {
  const [tab = 'paradero', arg] = location.hash.slice(1).split('/');
  const valid = ['paradero', 'cerca', 'metro'].includes(tab) ? tab : 'paradero';

  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${valid}`));
  document.querySelectorAll('.tabbar a').forEach((a) => {
    if (a.dataset.tab === valid) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  stopRefresh();
  if (valid === 'paradero') {
    renderFavorites();
    if (arg) showStop(decodeURIComponent(arg).toUpperCase());
  } else if (valid === 'metro') {
    loadMetro();
  } else if (valid === 'cerca') {
    state.map?.invalidateSize();
  }
}

// ---------- Paradero ----------

function renderFavorites() {
  const favs = storage(FAV_KEY) || [];
  $('#favorites').innerHTML = favs.length
    ? favs.map((c) => `<a class="chip" href="#paradero/${encodeURIComponent(c)}">⭐ ${escapeHtml(c)}</a>`).join('')
    : '<span class="muted">Marca paraderos con ⭐ para tenerlos aquí.</span>';
}

function toggleFavorite(codigo) {
  const favs = storage(FAV_KEY) || [];
  const i = favs.indexOf(codigo);
  if (i >= 0) favs.splice(i, 1);
  else favs.unshift(codigo);
  storage(FAV_KEY, favs.slice(0, 12));
  renderFavorites();
  return i < 0;
}

async function onSearch(e) {
  e.preventDefault();
  const q = $('#search').value.trim();
  const list = $('#search-results');
  list.innerHTML = '';
  if (!q) return;

  if (STOP_CODE.test(q.toUpperCase())) {
    location.hash = `paradero/${q.toUpperCase()}`;
    return;
  }

  stopRefresh();
  state.currentStop = null;
  $('#stop').innerHTML = '';
  delete $('#stop').dataset.codigo;

  try {
    await loadStaticData();
  } catch {
    list.innerHTML = '<li class="muted">No se pudo cargar la lista de paraderos.</li>';
    return;
  }
  const words = normalize(q).split(/\s+/);
  const found = state.paraderos.filter((p) => words.every((w) => normalize(p[1]).includes(w))).slice(0, 25);
  list.innerHTML = found.length
    ? found.map(stopListItem).join('')
    : '<li class="muted">No se encontraron paraderos con ese nombre.</li>';
}

function stopListItem([codigo, nombre, , , recorridos], extra = '') {
  return `<li><button data-stop="${escapeHtml(codigo)}">
    <strong>${escapeHtml(codigo)}</strong> · ${escapeHtml(nombre)} ${extra}<br>
    <small>${recorridos.map(escapeHtml).join(' · ')}</small>
  </button></li>`;
}

function formatEta(b) {
  if (b.minutosMax <= 1) return 'Llegando';
  if (b.minutosMin === b.minutosMax) return `${b.minutosMin} min`;
  return `${b.minutosMin}–${b.minutosMax} min`;
}

async function showStop(codigo) {
  state.currentStop = codigo;
  $('#search-results').innerHTML = '';
  const box = $('#stop');
  if (!box.dataset.codigo || box.dataset.codigo !== codigo) {
    box.innerHTML = '<div class="card muted">Consultando buses…</div>';
    box.dataset.codigo = codigo;
  }

  loadStaticData().catch(() => {});
  let data;
  try {
    data = await getJson(`/api/paradero?codigo=${encodeURIComponent(codigo)}`);
  } catch (err) {
    if (state.currentStop === codigo) box.innerHTML = `<div class="card">⚠️ ${escapeHtml(err.message)}</div>`;
    return scheduleRefresh(codigo);
  }
  if (state.currentStop !== codigo) return;

  const isFav = (storage(FAV_KEY) || []).includes(codigo);
  const services = [...data.servicios].sort((a, b) => {
    const eta = (s) => (s.buses[0] ? s.buses[0].minutosMin : Infinity);
    return eta(a) - eta(b);
  });

  box.innerHTML = `
    <div class="card">
      <div class="stop-head">
        <div>
          <h2>${escapeHtml(data.codigo)}</h2>
          <div class="muted">${escapeHtml(findStop(codigo)?.[1] || data.nombre)}</div>
        </div>
        <button class="star" id="fav" aria-label="Favorito" aria-pressed="${isFav}">${isFav ? '★' : '☆'}</button>
      </div>
      <small class="muted">Actualizado ${new Date(data.actualizado).toLocaleTimeString('es-CL')} · se refresca cada 30 s</small>
    </div>
    ${services
      .map(
        (s) => `<div class="card service">
          ${routeBadge(s.recorrido)}
          <ul>${
            s.buses.length
              ? s.buses
                  .map((b) => `<li><span class="eta">${formatEta(b)}</span> <small class="muted">· ${(b.distancia / 1000).toFixed(1)} km · ${escapeHtml(b.patente)}</small></li>`)
                  .join('')
              : `<li class="muted">${escapeHtml(s.mensaje)}</li>`
          }</ul>
        </div>`,
      )
      .join('')}`;

  $('#fav').onclick = (e) => {
    const now = toggleFavorite(codigo);
    e.currentTarget.textContent = now ? '★' : '☆';
    e.currentTarget.setAttribute('aria-pressed', now);
  };
  scheduleRefresh(codigo);
}

function scheduleRefresh(codigo) {
  stopRefresh();
  state.refreshTimer = setTimeout(() => {
    if (document.visibilityState === 'visible' && state.currentStop === codigo) showStop(codigo);
    else scheduleRefresh(codigo);
  }, REFRESH_MS);
}

function stopRefresh() {
  clearTimeout(state.refreshTimer);
}

// ---------- Cerca ----------

function distanceMeters(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(a));
}

function locate() {
  const list = $('#nearby');
  if (!('geolocation' in navigator)) {
    list.innerHTML = '<li class="muted">Tu navegador no permite obtener la ubicación.</li>';
    return;
  }
  list.innerHTML = '<li class="muted">Obteniendo tu ubicación…</li>';
  navigator.geolocation.getCurrentPosition(
    async ({ coords }) => {
      try {
        await loadStaticData();
      } catch {
        list.innerHTML = '<li class="muted">No se pudo cargar la lista de paraderos.</li>';
        return;
      }
      const { latitude: lat, longitude: lon } = coords;
      const near = state.paraderos
        .map((p) => ({ p, d: distanceMeters(lat, lon, p[2], p[3]) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 15);
      list.innerHTML = near.map(({ p, d }) => stopListItem(p, `<small class="muted">(${Math.round(d)} m)</small>`)).join('');
      drawMap(lat, lon, near.map((n) => n.p));
    },
    (err) => {
      list.innerHTML = `<li class="muted">No se pudo obtener tu ubicación (${escapeHtml(err.message)}).</li>`;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
}

function drawMap(lat, lon, stops) {
  if (!window.L) return; // Leaflet no disponible (por ejemplo, sin conexión)
  const el = $('#map');
  el.classList.add('visible');
  if (!state.map) {
    state.map = L.map(el);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(state.map);
    state.markers = L.layerGroup().addTo(state.map);
  }
  state.markers.clearLayers();
  L.circleMarker([lat, lon], { radius: 8, color: '#1a73e8', fillOpacity: 0.9 }).bindPopup('Estás aquí').addTo(state.markers);
  for (const [codigo, nombre, sLat, sLon] of stops) {
    L.marker([sLat, sLon])
      .bindPopup(`<strong>${escapeHtml(codigo)}</strong><br>${escapeHtml(nombre)}<br><a href="#paradero/${encodeURIComponent(codigo)}">Ver buses</a>`)
      .addTo(state.markers);
  }
  state.map.invalidateSize();
  state.map.fitBounds(L.latLngBounds([[lat, lon], ...stops.map((s) => [s[2], s[3]])]), { padding: [24, 24] });
}

// ---------- Metro ----------

async function loadMetro() {
  const box = $('#metro');
  if (!box.innerHTML) box.innerHTML = '<div class="card muted">Consultando estado de la red…</div>';
  let data;
  try {
    data = await getJson('/api/metro');
  } catch (err) {
    box.innerHTML = `<div class="card">⚠️ ${escapeHtml(err.message)}</div>`;
    return;
  }

  box.innerHTML =
    data.lineas
      .map((l) => {
        const closed = l.estaciones.filter((e) => !e.operativa);
        const color = METRO_COLORS[l.id] || 'var(--muted)';
        const ok = l.operativa && closed.length === 0;
        const summary = ok ? 'Operación normal' : l.mensaje || `${closed.length} estación(es) con problemas`;
        return `<details class="card">
          <summary class="line">
            <span class="badge" style="background:${color};color:#fff">${escapeHtml(l.id)}</span>
            <span class="${ok ? 'status-ok' : 'status-bad'}">${escapeHtml(summary)}</span>
          </summary>
          <ol class="stations">${l.estaciones
            .map(
              (e) => `<li class="${e.operativa ? '' : 'status-bad'}">${escapeHtml(e.nombre)}${e.operativa ? '' : ` — ${escapeHtml(e.estado)}`}</li>`,
            )
            .join('')}</ol>
        </details>`;
      })
      .join('') + `<p class="muted"><small>Actualizado ${new Date(data.actualizado).toLocaleTimeString('es-CL')} · Fuente: metro.cl</small></p>`;
}

// ---------- PWA ----------

function setupPwa() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker:', err));
  }

  let deferred;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('#install').hidden = false;
  });
  $('#install').onclick = async () => {
    $('#install').hidden = true;
    deferred?.prompt();
    deferred = null;
  };

  const updateOnline = () => ($('#offline').hidden = navigator.onLine);
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();
}

// ---------- Inicio ----------

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-stop]');
  if (btn) location.hash = `paradero/${btn.dataset.stop}`;
});
$('#search-form').addEventListener('submit', onSearch);
$('#locate').addEventListener('click', locate);
$('#metro-refresh').addEventListener('click', loadMetro);
window.addEventListener('hashchange', route);

setupPwa();
route();
