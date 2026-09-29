// GET /api/metro
// Estado de las líneas y estaciones de Metro de Santiago (fuente: JSON público del sitio metro.cl).

const UPSTREAM = 'https://www.metro.cl/api/estadoRedDetalle.php';

export default async function handler(req, res) {
  try {
    const r = await fetch(UPSTREAM, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    const lineas = Object.entries(data).map(([id, l]) => ({
      id: id.toUpperCase(),
      operativa: l.estado === '1',
      mensaje: l.mensaje_app || l.mensaje || '',
      estaciones: (l.estaciones || []).map((e) => ({
        nombre: e.nombre,
        codigo: e.codigo,
        operativa: e.estado === '1',
        estado: e.descripcion_app || e.descripcion || '',
        combinacion: e.combinacion || '',
        mensaje: e.mensaje || '',
      })),
    }));

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=60');
    return res.status(200).json({ actualizado: new Date().toISOString(), lineas });
  } catch (err) {
    return res.status(502).json({ error: 'No se pudo consultar el estado de Metro.', detalle: err.message });
  }
}
