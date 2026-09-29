'use strict';

const $ = (sel) => document.querySelector(sel);
const REFRESH_MS = 30000;
const FAV_KEY = 'favoritos';
const RECENT_KEY = 'recientes';
const STOP_CODE = /^[A-Z]{1,3}\d{1,5}$/;
const SUGGESTIONS = ['PA1', 'PC145', 'PJ178', 'PI587'];

// Colores oficiales aproximados de las líneas de Metro.
const METRO_COLORS = {
  L1: '#e3051b', L2: '#f5a800', L3: '#7a4a1e', L4: '#0033a0',
  L4A: '#1ba1e2', L5: '#0b9444', L6: '#9b2a94', L7: '#8a8d91',
};

const state = {
  paraderos: null, // [[codigo, nombre, lat, lon, [recorridos]]]
  byCode: null, // Map codigo -> paradero
  recorridos: null, // Map recorrido -> {nombre, color, colorTexto}
  currentStop: null,
  lastUpdate: null,
  refreshTimer: null,
  map: null,
  markers: null,
  position: null,
};

const icon = (name, cls = 'i') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const formatKm = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toLocaleString('es-CL', { maximumFractionDigits: 1 })} km`);

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

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Datos estáticos (GTFS preprocesado) ----------

let staticPromise;
function loadStaticData() {
  staticPromise ??= Promise.all([getJson('/data/paraderos.json'), getJson('/data/recorridos.json')])
    .then(([paraderos, recorridos]) => {
      state.paraderos = paraderos;
      state.byCode = new Map(paraderos.map((p) => [p[0], p]));
      state.recorridos = new Map(recorridos.map(([id, nombre, , color, colorTexto]) => [id, { nombre, color, colorTexto }]));
    })
    .catch((err) => {
      staticPromise = null;
      throw err;
    });
  return staticPromise;
}

function routeBadge(id) {
  const r = state.recorridos?.get(id);
  const bg = r ? `#${r.color}` : 'var(--accent)';
  const fg = r ? `#${r.colorTexto}` : 'var(--accent-text)';
  return `<span class="badge" style="background:${bg};color:${fg}">${escapeHtml(id)}</span>`;
}

function miniRoutes(ids, max = 8) {
  const extra = ids.length - max;
  return `<div class="mini-routes">${ids.slice(0, max).map(routeBadge).join('')}${extra > 0 ? `<span class="more">+${extra}</span>` : ''}</div>`;
}

function stopItem(p, { dist, removable } = {}) {
  const [codigo, nombre, , , recorridos] = p;
  return `<li><div class="stop-item" role="button" tabindex="0" data-stop="${escapeHtml(codigo)}">
    <div class="body">
      <div class="meta"><span class="code">${escapeHtml(codigo)}</span>${dist != null ? `<span class="dist">${formatKm(dist)}</span>` : ''}</div>
      <div class="name">${escapeHtml(nombre)}</div>
      ${recorridos?.length ? miniRoutes(recorridos) : ''}
    </div>
    ${removable ? `<button class="remove" data-remove="${escapeHtml(codigo)}" aria-label="Quitar de favoritos">${icon('x')}</button>` : ''}
  </div></li>`;
}

// Paradero sin datos estáticos cargados (o que no está en el GTFS).
const stopOrStub = (codigo) => state.byCode?.get(codigo) || [codigo, 'Paradero', 0, 0, []];

// ---------- Navegación ----------

function route() {
  const [tab = 'paradero', arg] = location.hash.slice(1).split('/');
  const valid = ['paradero', 'cerca', 'metro'].includes(tab) ? tab : 'paradero';

  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${valid}`));
  document.querySelectorAll('.tabbar a').forEach((a) => {
    if (a.dataset.tab === valid) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#subtitle').textContent = { paradero: 'Buses en tiempo real', cerca: 'Paraderos cercanos', metro: 'Estado de la red' }[valid];

  stopRefresh();
  if (valid === 'paradero') {
    if (arg) showStop(decodeURIComponent(arg).toUpperCase());
    else closeStop();
  } else if (valid === 'metro') {
    loadMetro();
  } else if (valid === 'cerca') {
    state.map?.invalidateSize();
  }
  window.scrollTo(0, 0);
}

// ---------- Inicio (favoritos y recientes) ----------

function renderHome() {
  const home = $('#home');
  const favs = storage(FAV_KEY) || [];
  const recents = (storage(RECENT_KEY) || []).filter((c) => !favs.includes(c)).slice(0, 5);

  let html = '';
  if (favs.length) {
    html += `<section class="block"><h3 class="block-title">${icon('star')}Favoritos</h3>
      <ul class="list">${favs.map((c) => stopItem(stopOrStub(c), { removable: true })).join('')}</ul></section>`;
  }
  if (recents.length) {
    html += `<section class="block"><h3 class="block-title">${icon('clock')}Recientes</h3>
      <ul class="list">${recents.map((c) => stopItem(stopOrStub(c))).join('')}</ul></section>`;
  }
  if (!favs.length) {
    html += `<div class="hero block">
      <div class="hero-icon">${icon('bus')}</div>
      <h2>¿Cuándo llega mi micro?</h2>
      <p class="muted">Escribe el código que aparece en el letrero del paradero, o búscalo por nombre. Marca con ★ los que más usas.</p>
      <div class="suggestions">${SUGGESTIONS.map((c) => `<button class="chip" data-stop="${c}">${c}</button>`).join('')}</div>
    </div>`;
  }
  home.innerHTML = html;

  // Completa nombres y recorridos cuando llegan los datos estáticos.
  if (!state.paraderos && (favs.length || recents.length)) loadStaticData().then(renderHome, () => {});
}

function toggleFavorite(codigo) {
  const favs = storage(FAV_KEY) || [];
  const i = favs.indexOf(codigo);
  if (i >= 0) favs.splice(i, 1);
  else favs.unshift(codigo);
  storage(FAV_KEY, favs.slice(0, 12));
  return i < 0;
}

function addRecent(codigo) {
  const list = (storage(RECENT_KEY) || []).filter((c) => c !== codigo);
  list.unshift(codigo);
  storage(RECENT_KEY, list.slice(0, 10));
}

// ---------- Búsqueda ----------

async function runSearch() {
  const q = $('#search').value.trim();
  const list = $('#search-results');
  if (q.length < 2) {
    list.innerHTML = '';
    updateParaderoLayout();
    return;
  }
  try {
    await loadStaticData();
  } catch {
    list.innerHTML = '<li class="empty">No se pudo cargar la lista de paraderos.</li>';
    return;
  }
  if ($('#search').value.trim() !== q) return; // el usuario siguió escribiendo

  let found;
  const upper = q.toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z]{1,3}\d+$/.test(upper)) {
    found = state.paraderos.filter((p) => p[0].startsWith(upper));
  } else {
    const words = normalize(q).split(/\s+/);
    found = state.paraderos.filter((p) => words.every((w) => normalize(p[1]).includes(w)));
  }
  list.innerHTML = found.length
    ? found.slice(0, 30).map((p) => stopItem(p)).join('')
    : '<li class="empty">No se encontraron paraderos.</li>';
  updateParaderoLayout();
}

function onSubmit(e) {
  e.preventDefault();
  const q = $('#search').value.trim().toUpperCase().replace(/\s+/g, '');
  if (STOP_CODE.test(q)) openStop(q);
  else runSearch();
}

function openStop(codigo) {
  $('#search').value = '';
  $('#search-results').innerHTML = '';
  $('#search').blur();
  location.hash = `paradero/${codigo}`;
}

function updateParaderoLayout() {
  const searching = $('#search-results').innerHTML !== '';
  $('#home').hidden = searching || !!state.currentStop;
  $('#stop').hidden = searching || !state.currentStop;
}

// ---------- Paradero ----------

function closeStop() {
  state.currentStop = null;
  $('#stop').innerHTML = '';
  delete $('#stop').dataset.codigo;
  renderHome();
  updateParaderoLayout();
}

function skeleton(codigo) {
  const row = `<div class="service"><div class="sk" style="width:54px;height:30px"></div>
    <div style="flex:1"><div class="sk" style="width:70%;height:12px"></div></div>
    <div class="sk" style="width:56px;height:28px"></div></div>`;
  return `<div class="stop-header"><div class="row">
      <button class="back" data-close aria-label="Volver">${icon('back')}</button>
      <div class="title"><span class="code">${escapeHtml(codigo)}</span><div class="sk" style="width:60%;height:18px;margin-top:8px"></div></div>
    </div></div>
    <div class="services">${row.repeat(4)}</div>`;
}

function etaBlock(buses) {
  const [first, second] = buses;
  const main =
    first.minutosMax <= 1
      ? '<div class="now">Llegando</div>'
      : `<div class="big">${first.minutosMin === first.minutosMax ? first.minutosMin : `${first.minutosMin}–${first.minutosMax}`}<small>min</small></div>`;
  const next = second
    ? `Luego ${second.minutosMin}–${second.minutosMax} min`
    : formatKm(first.distancia);
  return `<div class="eta">${main}<div class="next">${next}</div></div>`;
}

async function showStop(codigo) {
  const isNew = state.currentStop !== codigo;
  state.currentStop = codigo;
  $('#search-results').innerHTML = '';
  updateParaderoLayout();

  const box = $('#stop');
  if (box.dataset.codigo !== codigo) {
    box.innerHTML = skeleton(codigo);
    box.dataset.codigo = codigo;
  }
  if (isNew) addRecent(codigo);

  loadStaticData().catch(() => {});
  const refreshBtn = $('#stop [data-refresh]');
  refreshBtn?.classList.add('spin');

  let data;
  try {
    data = await getJson(`/api/paradero?codigo=${encodeURIComponent(codigo)}`);
  } catch (err) {
    if (state.currentStop !== codigo) return;
    refreshBtn?.classList.remove('spin');
    if (box.querySelector('.services .sk') || !box.querySelector('.services')) {
      box.innerHTML = `<div class="stop-header"><div class="row">
          <button class="back" data-close aria-label="Volver">${icon('back')}</button>
          <div class="title"><span class="code">${escapeHtml(codigo)}</span><h2>${escapeHtml(stopOrStub(codigo)[1])}</h2></div>
          <div class="actions"><button class="icon-btn" data-refresh aria-label="Reintentar">${icon('refresh')}</button></div>
        </div></div>
        <div class="error-card">${icon('alert')}<div>${escapeHtml(err.message)}</div></div>`;
    } else {
      box.querySelector('.dot')?.classList.add('stale');
    }
    return scheduleRefresh(codigo);
  }
  if (state.currentStop !== codigo) return;
  await loadStaticData().catch(() => {});

  const isFav = (storage(FAV_KEY) || []).includes(codigo);
  const withBuses = data.servicios.filter((s) => s.buses.length);
  const without = data.servicios.filter((s) => !s.buses.length);
  withBuses.sort((a, b) => a.buses[0].minutosMin - b.buses[0].minutosMin || a.buses[0].distancia - b.buses[0].distancia);

  const serviceRow = (s) => `<div class="service${s.buses.length ? '' : ' off'}">
      ${routeBadge(s.recorrido)}
      <div class="dest"><span>${escapeHtml(state.recorridos?.get(s.recorrido)?.nombre || '')}</span></div>
      ${s.buses.length ? etaBlock(s.buses) : `<div class="eta">${escapeHtml(s.mensaje)}</div>`}
    </div>`;

  state.lastUpdate = Date.now();
  box.innerHTML = `
    <div class="stop-header">
      <div class="row">
        <button class="back" data-close aria-label="Volver">${icon('back')}</button>
        <div class="title">
          <span class="code">${escapeHtml(data.codigo)}</span>
          <h2>${escapeHtml(state.byCode?.get(codigo)?.[1] || data.nombre)}</h2>
        </div>
        <div class="actions">
          <button class="icon-btn" data-refresh aria-label="Actualizar">${icon('refresh')}</button>
          <button class="icon-btn${isFav ? ' on' : ''}" data-fav aria-label="Favorito" aria-pressed="${isFav}">${icon('star')}</button>
        </div>
      </div>
      <div class="live"><span class="dot"></span><span id="updated">En vivo · actualizado recién</span></div>
      <div class="progress"></div>
    </div>
    <div class="services">
      ${withBuses.length ? withBuses.map(serviceRow).join('') : '<div class="empty">No hay buses aproximándose en este momento.</div>'}
      ${without.length ? `<div class="section-label">Sin buses próximos</div>${without.map(serviceRow).join('')}` : ''}
    </div>`;
  scheduleRefresh(codigo);
}

function updateAgo() {
  const el = $('#updated');
  if (!el || !state.lastUpdate) return;
  const s = Math.round((Date.now() - state.lastUpdate) / 1000);
  el.textContent = `En vivo · actualizado ${s < 5 ? 'recién' : `hace ${s} s`}`;
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
  const btn = $('#locate');
  if (!('geolocation' in navigator)) {
    list.innerHTML = '<li class="empty">Tu navegador no permite obtener la ubicación.</li>';
    return;
  }
  btn.disabled = true;
  btn.lastChild.textContent = 'Buscando…';
  navigator.geolocation.getCurrentPosition(
    async ({ coords }) => {
      btn.disabled = false;
      btn.lastChild.textContent = 'Usar mi ubicación';
      try {
        await loadStaticData();
      } catch {
        list.innerHTML = '<li class="empty">No se pudo cargar la lista de paraderos.</li>';
        return;
      }
      const { latitude: lat, longitude: lon } = coords;
      const near = state.paraderos
        .map((p) => ({ p, d: distanceMeters(lat, lon, p[2], p[3]) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 15);
      $('#cerca-hero').hidden = true;
      $('#nearby-head').hidden = false;
      list.innerHTML = near.map(({ p, d }) => stopItem(p, { dist: d })).join('');
      drawMap(lat, lon, near.map((n) => n.p));
    },
    (err) => {
      btn.disabled = false;
      btn.lastChild.textContent = 'Usar mi ubicación';
      const msg = err.code === 1 ? 'Debes permitir el acceso a tu ubicación en el navegador.' : 'No se pudo obtener tu ubicación. Intenta de nuevo.';
      list.innerHTML = `<li class="error-card">${icon('alert')}<div>${msg}</div></li>`;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
}

function drawMap(lat, lon, stops) {
  if (!window.L) return; // Leaflet no disponible (por ejemplo, sin conexión)
  const el = $('#map');
  el.classList.add('visible');
  if (!state.map) {
    state.map = L.map(el, { zoomControl: false });
    L.control.zoom({ position: 'bottomright' }).addTo(state.map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(state.map);
    state.markers = L.layerGroup().addTo(state.map);
  }
  state.markers.clearLayers();
  L.circleMarker([lat, lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 })
    .bindPopup('Estás aquí')
    .addTo(state.markers);
  for (const [codigo, nombre, sLat, sLon] of stops) {
    L.circleMarker([sLat, sLon], { radius: 7, color: '#fff', weight: 2, fillColor: '#d7132f', fillOpacity: 1 })
      .bindPopup(`<strong>${escapeHtml(codigo)}</strong><br>${escapeHtml(nombre)}<br><a href="#paradero/${encodeURIComponent(codigo)}">Ver buses →</a>`)
      .addTo(state.markers);
  }
  state.map.invalidateSize();
  state.map.fitBounds(L.latLngBounds([[lat, lon], ...stops.map((s) => [s[2], s[3]])]), { padding: [24, 24] });
}

// ---------- Metro ----------

async function loadMetro() {
  const box = $('#metro');
  const btn = $('#metro-refresh');
  if (!box.innerHTML) {
    box.innerHTML = `<div class="sk" style="height:56px;border-radius:16px;margin-bottom:12px"></div>` +
      '<div class="sk" style="height:62px;border-radius:16px;margin-top:8px"></div>'.repeat(7);
  }
  btn.disabled = true;
  let data;
  try {
    data = await getJson('/api/metro');
  } catch (err) {
    box.innerHTML = `<div class="error-card">${icon('alert')}<div>${escapeHtml(err.message)}</div></div>`;
    return;
  } finally {
    btn.disabled = false;
  }

  const lines = data.lineas.map((l) => ({ ...l, closed: l.estaciones.filter((e) => !e.operativa) }));
  const problems = lines.filter((l) => !l.operativa || l.closed.length);
  const summary = problems.length
    ? `<div class="summary bad">${icon('alert')}<div>${problems.length === 1 ? '1 línea con problemas' : `${problems.length} líneas con problemas`}<small>Revisa el detalle antes de viajar.</small></div></div>`
    : `<div class="summary ok">${icon('check')}<div>Toda la red funciona con normalidad<small>${lines.length} líneas operativas</small></div></div>`;

  box.innerHTML =
    summary +
    lines
      .map((l) => {
        const color = METRO_COLORS[l.id] || 'var(--muted)';
        const ok = l.operativa && l.closed.length === 0;
        const status = ok ? 'Operación normal' : l.mensaje && l.mensaje !== 'Línea disponible' ? l.mensaje : `${l.closed.length} estación(es) cerrada(s)`;
        return `<details class="line-card" style="--line:${color}"${ok ? '' : ' open'}>
          <summary>
            <span class="line-dot">${escapeHtml(l.id.replace('L', ''))}</span>
            <span class="lname"><strong>Línea ${escapeHtml(l.id.replace('L', ''))}</strong><span class="${ok ? 'status-ok' : 'status-bad'}">${escapeHtml(status)}</span></span>
            <span class="chev">${icon('chevron')}</span>
          </summary>
          <ol class="stations">${l.estaciones
            .map((e) => {
              const transfers = e.combinacion
                .split(/[,\s-]+/)
                .filter(Boolean)
                .map((c) => `<span class="transfer" style="background:${METRO_COLORS[c.toUpperCase()] || 'var(--muted)'}">${escapeHtml(c)}</span>`)
                .join('');
              return `<li class="${e.operativa ? '' : 'closed'}">${escapeHtml(e.nombre)}${transfers}${e.operativa ? '' : ` · ${escapeHtml(e.estado)}`}</li>`;
            })
            .join('')}</ol>
        </details>`;
      })
      .join('') +
    `<p class="footnote">Actualizado a las ${new Date(data.actualizado).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })} · Fuente: metro.cl</p>`;
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
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    toggleFavorite(remove.dataset.remove);
    renderHome();
    return;
  }
  if (e.target.closest('[data-close]')) {
    location.hash = 'paradero';
    return;
  }
  if (e.target.closest('[data-refresh]') && state.currentStop) {
    showStop(state.currentStop);
    return;
  }
  const fav = e.target.closest('[data-fav]');
  if (fav && state.currentStop) {
    const on = toggleFavorite(state.currentStop);
    fav.classList.toggle('on', on);
    fav.setAttribute('aria-pressed', on);
    return;
  }
  const stop = e.target.closest('[data-stop]');
  if (stop) openStop(stop.dataset.stop);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.stop-item')) openStop(e.target.dataset.stop);
});

$('#search-form').addEventListener('submit', onSubmit);
$('#search').addEventListener('input', debounce(runSearch, 200));
$('#locate').addEventListener('click', locate);
$('#relocate').addEventListener('click', locate);
$('#metro-refresh').addEventListener('click', loadMetro);
window.addEventListener('hashchange', route);
setInterval(updateAgo, 1000);

setupPwa();
route();
