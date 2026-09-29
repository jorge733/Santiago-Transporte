// Descarga el GTFS de Santiago y genera JSONs livianos para la app:
//   data/paraderos.json  -> [codigo, nombre, lat, lon, [recorridos]]
//   data/recorridos.json -> [id, nombre, descripcion, color, colorTexto]
//   data/meta.json       -> fuente y fecha de generación
//
// Uso: npm run build:gtfs            (descarga automática)
//      GTFS_URL=https://... npm run build:gtfs
//      GTFS_FILE=./GTFS.zip npm run build:gtfs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';

const DTPM_PAGE = 'https://www.dtpm.cl/index.php/noticias/gtfs-vigente';
// Copia pública del GTFS de DTPM mantenida por Mobility Database.
const MIRROR = 'https://files.mobilitydatabase.org/mdb-3357/latest.zip';
const OUT = new URL('../data/', import.meta.url);

async function fetchWithTimeout(url, ms = 60000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: { 'User-Agent': 'Mozilla/5.0 (santiago-transporte build)' },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}

// Busca en la página de DTPM el enlace al ZIP vigente.
async function findDtpmZip() {
  const html = await (await fetchWithTimeout(DTPM_PAGE, 30000)).text();
  const m = html.match(/href="([^"]*\/descargas\/gtfs\/[^"]+\.zip)"/i);
  if (!m) throw new Error('No se encontró el enlace al GTFS en la página de DTPM');
  return new URL(m[1], DTPM_PAGE).href;
}

async function downloadGtfs() {
  if (process.env.GTFS_FILE) {
    return { bytes: await readFile(process.env.GTFS_FILE), source: process.env.GTFS_FILE };
  }
  const candidates = [];
  if (process.env.GTFS_URL) candidates.push(() => process.env.GTFS_URL);
  candidates.push(findDtpmZip, () => MIRROR);

  for (const getUrl of candidates) {
    try {
      const url = await getUrl();
      console.log(`Descargando ${url} ...`);
      const res = await fetchWithTimeout(url, 180000);
      return { bytes: new Uint8Array(await res.arrayBuffer()), source: url };
    } catch (err) {
      console.warn(`  falló: ${err.message}`);
    }
  }
  throw new Error('No se pudo descargar el GTFS desde ninguna fuente');
}

// Algunos ZIP de DTPM traen otro ZIP adentro (ej. GTFS_xxx/gtfs_data.zip).
function extractGtfs(bytes) {
  const wanted = ['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'feed_info.txt'];
  let files = unzipSync(bytes, {
    filter: (f) => wanted.some((w) => f.name.endsWith(w)) || f.name.endsWith('.zip'),
  });
  const inner = Object.keys(files).find((n) => n.endsWith('.zip'));
  if (!Object.keys(files).some((n) => n.endsWith('stops.txt')) && inner) {
    return extractGtfs(files[inner]);
  }
  const byName = {};
  for (const [name, data] of Object.entries(files)) {
    const base = name.split('/').pop();
    if (wanted.includes(base)) byName[base] = data;
  }
  return byName;
}

// Parser CSV simple con soporte de comillas.
function* parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = splitLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cols = splitLine(lines[i]);
    const row = {};
    header.forEach((h, j) => (row[h] = cols[j] ?? ''));
    yield row;
  }
}

function splitLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const round = (n) => Math.round(Number(n) * 1e5) / 1e5;

async function main() {
  const { bytes, source } = await downloadGtfs();
  const f = extractGtfs(bytes);
  for (const name of ['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt']) {
    if (!f[name]) throw new Error(`El GTFS no contiene ${name}`);
  }

  const routes = new Map();
  for (const r of parseCsv(strFromU8(f['routes.txt']))) routes.set(r.route_id, r);

  const tripRoute = new Map();
  for (const t of parseCsv(strFromU8(f['trips.txt']))) tripRoute.set(t.trip_id, t.route_id);

  // Qué recorridos de bus (route_type 3) se detienen en cada parada.
  const stopRoutes = new Map();
  for (const st of parseCsv(strFromU8(f['stop_times.txt']))) {
    const route = routes.get(tripRoute.get(st.trip_id));
    if (!route || route.route_type !== '3') continue;
    let set = stopRoutes.get(st.stop_id);
    if (!set) stopRoutes.set(st.stop_id, (set = new Set()));
    set.add(route.route_short_name || route.route_id);
  }

  const collator = new Intl.Collator('es', { numeric: true });
  const paraderos = [];
  for (const s of parseCsv(strFromU8(f['stops.txt']))) {
    const served = stopRoutes.get(s.stop_id);
    if (!served) continue;
    const codigo = s.stop_code || s.stop_id;
    const nombre = s.stop_name.replace(new RegExp(`^${codigo}-`), '').trim();
    paraderos.push([codigo, nombre, round(s.stop_lat), round(s.stop_lon), [...served].sort(collator.compare)]);
  }
  paraderos.sort((a, b) => collator.compare(a[0], b[0]));

  const recorridos = [...routes.values()]
    .filter((r) => r.route_type === '3')
    .map((r) => [r.route_short_name || r.route_id, r.route_long_name, r.route_desc, r.route_color || 'AF2B1E', r.route_text_color || 'FFFFFF'])
    .sort((a, b) => collator.compare(a[0], b[0]));

  let vigencia = null;
  if (f['feed_info.txt']) {
    const info = parseCsv(strFromU8(f['feed_info.txt'])).next().value;
    if (info) vigencia = { desde: info.feed_start_date || null, hasta: info.feed_end_date || null, version: info.feed_version || null };
  }

  await mkdir(OUT, { recursive: true });
  await writeFile(new URL('paraderos.json', OUT), JSON.stringify(paraderos));
  await writeFile(new URL('recorridos.json', OUT), JSON.stringify(recorridos));
  await writeFile(
    new URL('meta.json', OUT),
    JSON.stringify({ fuente: source, vigencia, paraderos: paraderos.length, recorridos: recorridos.length }, null, 2) + '\n',
  );
  console.log(`Listo: ${paraderos.length} paraderos, ${recorridos.length} recorridos.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
