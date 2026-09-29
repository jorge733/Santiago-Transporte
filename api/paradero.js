// GET /api/paradero?codigo=PA1
// Tiempos de llegada de buses a un paradero (fuente: api.xor.cl, que consulta el predictor de Red).

const UPSTREAM = 'https://api.xor.cl/red/bus-stop/';

export default async function handler(req, res) {
  const codigo = String(req.query.codigo || '').trim().toUpperCase();
  if (!/^[A-Z]{1,3}\d{1,5}$/.test(codigo)) {
    return res.status(400).json({ error: 'Código de paradero inválido. Ejemplo: PA1' });
  }

  try {
    const r = await fetch(UPSTREAM + encodeURIComponent(codigo), { signal: AbortSignal.timeout(8000) });
    const data = await r.json().catch(() => null);
    if (!data) throw new Error(`Respuesta no válida (HTTP ${r.status})`);
    if (data.status_code !== 0) {
      return res.status(404).json({ error: 'No hay información para este paradero.', detalle: data.status_description });
    }

    res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=10');
    return res.status(200).json({
      codigo: data.id,
      nombre: data.name,
      actualizado: new Date().toISOString(),
      servicios: data.services.map((s) => ({
        recorrido: s.id,
        disponible: s.valid,
        mensaje: s.status_description,
        buses: (s.buses || []).map((b) => ({
          patente: b.id,
          distancia: b.meters_distance,
          minutosMin: b.min_arrival_time,
          minutosMax: b.max_arrival_time,
        })),
      })),
    });
  } catch (err) {
    return res.status(502).json({ error: 'No se pudo consultar el predictor de buses.', detalle: err.message });
  }
}
