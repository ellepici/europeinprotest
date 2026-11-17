// ============================================================
//  RETINO TIPOGRAFICO (halftone)
//
//  Al posto della heatmap: una griglia di pallini, come il retino
//  di stampa dei giornali. Più eventi ci sono in una zona, più il
//  pallino è grande (area proporzionale alla densità).
//
//  Come funziona, in breve:
//  1. Si divide il mondo in celle quadrate. La dimensione delle celle
//     dipende dallo zoom: zoomando la griglia si infittisce.
//  2. Per ogni cella si calcola la "densità" di eventi intorno al suo
//     centro: gli eventi vicini contano molto, quelli lontani poco
//     (una campana gaussiana larga 1,5 celle). Così il retino sfuma
//     tra una città e l'altra invece di fare puntini isolati.
//  3. La densità diventa il raggio del pallino. La scala è la stessa
//     per tutta l'Italia, quindi i pallini si confrontano tra regioni.
//  4. Si disegnano solo le celle dentro l'Italia (o dentro la regione
//     aperta) e solo quelle nello schermo: si ricalcola a ogni spostamento.
// ============================================================

const DOT = {
  cellPx: 4,         // lato della cella in pixel (= quanto è fitta la trama). Più basso = pallini più piccoli
  spreadPx: 18,      // larghezza della campana in pixel: quanto sfumano le zone tra una città e l'altra
  minTone: 0.015,    // sotto questa densità la cella resta bianca
  fill: 0.96,        // 1 = alla densità massima i pallini si toccano
  color: "#9A0008",  // un solo inchiostro, come in stampa (rosso scuro della style guide)
  gamma: 0.5,        // contrasto: 1 = proporzionale, più basso = le zone con pochi eventi si vedono di più
};

let dotPlaces = null; // eventi dell'anno, raggruppati per luogo e già proiettati
let dotMax = {};      // densità massima in Italia per ogni livello di zoom (cache)
let regionShapes = null; // regioni con riquadro, per il test "punto dentro la regione"

// coordinate geografiche -> coordinate "Mercatore" tra 0 e 1 (quelle di MapLibre)
function toWorld(lon, lat) {
  const m = maplibregl.MercatorCoordinate.fromLngLat([lon, lat]);
  return [m.x, m.y];
}

// --- preparazione, una volta per anno ---
function prepareDots() {
  const byPlace = {};
  for (const r of ROWS) {
    if (r.anno !== year) continue;
    const k = r.lon + "," + r.lat;
    if (!byPlace[k]) byPlace[k] = { lon: r.lon, lat: r.lat, n: 0 };
    byPlace[k].n += r.n;
  }
  dotPlaces = Object.values(byPlace).map((p) => {
    const [x, y] = toWorld(p.lon, p.lat);
    return { x, y, n: p.n };
  });
  dotMax = {};

  if (!regionShapes) {
    regionShapes = REGIONS.features.map((f) => {
      const g = f.geometry;
      const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates)
        .map((poly) => poly.map((ring) => ring.map(([lon, lat]) => toWorld(lon, lat))));
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (const poly of polys) for (const [x, y] of poly[0]) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      return { name: f.properties.name, polys, box: [x0, y0, x1, y1] };
    });
  }
}

// --- la griglia di un certo livello di zoom ---
function cellSize(band) {
  // 512 px è la larghezza del mondo a zoom 0; a ogni livello raddoppia
  return DOT.cellPx / (512 * Math.pow(2, band));
}

// Indice spaziale: mette i luoghi in "secchielli" grandi quanto il raggio
// d'influenza, così per ogni cella si guardano solo i luoghi vicini.
function bucketPlaces(reach) {
  const buckets = new Map();
  for (const p of dotPlaces) {
    const k = Math.floor(p.x / reach) + ":" + Math.floor(p.y / reach);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }
  return buckets;
}

function densityAt(x, y, sigma, reach, buckets) {
  const bx = Math.floor(x / reach), by = Math.floor(y / reach);
  const two = 2 * sigma * sigma;
  let v = 0;
  for (let i = bx - 1; i <= bx + 1; i++) {
    for (let j = by - 1; j <= by + 1; j++) {
      const list = buckets.get(i + ":" + j);
      if (!list) continue;
      for (const p of list) {
        const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d2 < reach * reach) v += p.n * Math.exp(-d2 / two);
      }
    }
  }
  return v;
}

// densità massima in tutta l'Italia per questo livello: fa da "nero pieno"
function maxDensity(band, sigma, reach, buckets) {
  if (dotMax[band] === undefined) {
    let m = 0;
    for (const p of dotPlaces) m = Math.max(m, densityAt(p.x, p.y, sigma, reach, buckets));
    dotMax[band] = m || 1;
  }
  return dotMax[band];
}

// Per una riga orizzontale (y) trova i tratti [x inizio, x fine] che stanno
// dentro le regioni: si contano gli incroci con i bordi (regola pari/dispari).
// Molto più veloce che controllare ogni singolo pallino.
function rowSpans(y, shapes) {
  const spans = [];
  for (const s of shapes) {
    if (y < s.box[1] || y > s.box[3]) continue;
    const xs = [];
    for (const poly of s.polys) {
      for (const ring of poly) {
        for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
          const [xi, yi] = ring[i], [xk, yk] = ring[k];
          if ((yi > y) !== (yk > y)) xs.push(xi + ((y - yi) * (xk - xi)) / (yk - yi));
        }
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
  }
  return spans;
}

// --- calcolo dei pallini visibili ---
function halftoneData() {
  if (!dotPlaces) prepareDots();

  const band = Math.max(0, Math.floor(map.getZoom()));
  const cell = cellSize(band);
  const sigma = cell * (DOT.spreadPx / DOT.cellPx);
  const reach = sigma * 3; // oltre 3 sigma la campana è praticamente zero
  const buckets = bucketPlaces(reach);
  const vmax = maxDensity(band, sigma, reach, buckets);

  // dove disegnare: le regioni (o solo quella aperta) dentro lo schermo, con un margine
  const shapes = selected ? regionShapes.filter((s) => s.name === selected) : regionShapes;
  const b = map.getBounds();
  let [vx0, vy1] = toWorld(b.getWest(), b.getSouth());
  let [vx1, vy0] = toWorld(b.getEast(), b.getNorth());
  const mx = (vx1 - vx0) * 0.25, my = (vy1 - vy0) * 0.25;
  vx0 -= mx; vx1 += mx; vy0 -= my; vy1 += my;
  const area = [
    Math.max(vx0, Math.min(...shapes.map((s) => s.box[0]))),
    Math.max(vy0, Math.min(...shapes.map((s) => s.box[1]))),
    Math.min(vx1, Math.max(...shapes.map((s) => s.box[2]))),
    Math.min(vy1, Math.max(...shapes.map((s) => s.box[3]))),
  ];

  const rMax = (DOT.cellPx / 2) * DOT.fill; // raggio massimo in pixel, al livello "band"
  const features = [];
  const j0 = Math.floor(area[1] / cell), j1 = Math.ceil(area[3] / cell);
  for (let j = j0; j <= j1; j++) {
    const y = (j + 0.5) * cell;
    // righe alternate sfalsate di mezza cella: dà la trama inclinata del retino
    const shift = j % 2 ? 0.5 : 0;
    for (const [xa, xb] of rowSpans(y, shapes)) {
      const i0 = Math.ceil(Math.max(xa, area[0]) / cell - 0.5 - shift);
      const i1 = Math.floor(Math.min(xb, area[2]) / cell - 0.5 - shift);
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5 + shift) * cell;
        const v = densityAt(x, y, sigma, reach, buckets);
        if (v <= 0) continue;
        // tono tra 0 (bianco) e 1 (pallino pieno). Con gamma < 1 Roma non schiaccia
        // tutto il resto, ma le zone con pochi eventi restano chiare.
        const tone = Math.pow(v / vmax, DOT.gamma);
        if (tone < DOT.minTone) continue;
        const ll = new maplibregl.MercatorCoordinate(x, y).toLngLat();
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [ll.lng, ll.lat] },
          // raggio a zoom 0: poi lo stile lo moltiplica per 2^zoom (vedi addHalftoneLayer)
          properties: { r0: (rMax * Math.sqrt(Math.min(1, tone))) / Math.pow(2, band) },
        });
      }
    }
  }
  return { type: "FeatureCollection", features };
}

// --- sorgente e layer ---
function addHalftoneLayer(beforeId) {
  map.addSource("dots", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "dots", type: "circle", source: "dots",
    paint: {
      // il raggio cresce col doppio a ogni livello di zoom, come la mappa:
      // così durante lo zoom i pallini restano "attaccati" al territorio
      "circle-radius": ["interpolate", ["exponential", 2], ["zoom"],
        0, ["get", "r0"],
        22, ["*", ["get", "r0"], 4194304]], // 4194304 = 2^22
      "circle-color": DOT.color,
      "circle-pitch-alignment": "map",
    },
  }, beforeId);
  // ricalcola quando la mappa si ferma (fine di pan e zoom)
  map.on("moveend", refreshHalftone);
}

function refreshHalftone() {
  const src = map.getSource("dots");
  if (src) src.setData(halftoneData());
}
