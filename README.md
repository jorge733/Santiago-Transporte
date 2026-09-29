# Santiago Transporte

PWA instalable con información del transporte público de Santiago de Chile, hecha con HTML, CSS y JavaScript sin frameworks, publicada en Vercel.

## Funciones

- **Paradero**: tiempos de llegada de buses en tiempo real. Busca por código (`PA1`) o por nombre ("plaza italia"), guarda favoritos ⭐ y se actualiza cada 30 segundos.
- **Cerca**: paraderos más cercanos a tu ubicación, en un mapa (Leaflet + OpenStreetMap), con los recorridos que pasan por cada uno.
- **Metro**: estado de cada línea y estación de Metro de Santiago.
- **Instalable y sin conexión**: manifest y service worker. Sin internet muestra los últimos datos guardados.

## Estructura

```
├── index.html              Interfaz (3 pestañas)
├── styles.css              Estilos (modo claro y oscuro)
├── app.js                  Lógica de la app
├── sw.js                   Service worker (caché y uso sin conexión)
├── manifest.webmanifest    Datos para instalar la PWA
├── icons/                  Íconos de la app
├── api/
│   ├── paradero.js         GET /api/paradero?codigo=PA1  -> buses en tiempo real
│   └── metro.js            GET /api/metro                -> estado de la red de Metro
├── data/                   Generado desde el GTFS (no editar a mano)
│   ├── paraderos.json      [codigo, nombre, lat, lon, [recorridos]]
│   ├── recorridos.json     [id, nombre, descripcion, color, colorTexto]
│   └── meta.json           Fuente y vigencia del GTFS
├── scripts/
│   ├── build-gtfs.mjs      Descarga el GTFS y genera data/
│   └── dev-server.mjs      Servidor local que imita a Vercel
├── .github/workflows/
│   └── actualizar-gtfs.yml Actualiza data/ cada lunes
└── vercel.json             Región (São Paulo) y cabeceras de caché
```

## Desarrollo local

Requiere Node.js 20 o superior.

```bash
npm install
npm run dev
```

Abre http://localhost:3000. El servidor local sirve los archivos y ejecuta las funciones de `api/` igual que Vercel.

Para regenerar los datos de paraderos y recorridos:

```bash
npm run build:gtfs
```

El script intenta descargar el GTFS vigente desde dtpm.cl y, si falla, usa la copia de [Mobility Database](https://mobilitydatabase.org). También acepta `GTFS_URL=...` o `GTFS_FILE=ruta/al/archivo.zip`.

## Publicar en Vercel

1. En [vercel.com/new](https://vercel.com/new), importa este repositorio.
2. Framework Preset: **Other**. No hace falta comando de build ni carpeta de salida.
3. Deploy. Cada push a `main` publica una nueva versión.

Las funciones corren en la región `gru1` (São Paulo), la más cercana a Chile.

## Fuentes de datos

| Dato | Fuente | Tipo |
|---|---|---|
| Paraderos y recorridos | GTFS de [DTPM](https://www.dtpm.cl/index.php/noticias/gtfs-vigente), con copia en Mobility Database | Oficial |
| Llegada de buses | [api.xor.cl](https://api.xor.cl/red/bus-stop/PA1) (consulta el predictor de Red) | No oficial |
| Estado de Metro | JSON público de [metro.cl](https://www.metro.cl/api/estadoRedDetalle.php) | No oficial |
| Mapa | © colaboradores de [OpenStreetMap](https://www.openstreetmap.org/copyright) | Abierto |

Las fuentes no oficiales pueden cambiar o dejar de funcionar sin aviso. Por eso la app las consulta siempre a través de `api/`: si una fuente cambia, basta con corregir un archivo.

## Notas

- Al modificar `index.html`, `styles.css` o `app.js`, sube `VERSION` en `sw.js` para que los usuarios reciban la versión nueva.
- Los mosaicos del mapa de OpenStreetMap son para uso moderado. Si la app crece, cámbialos por un proveedor como MapTiler, Stadia o Carto.
