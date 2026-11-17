// ============================================================
//  MASSE (circle packing)
//
//  Ogni evento è un cerchio. I cerchi si dispongono con una piccola
//  simulazione fisica, come granelli che si assestano:
//   - ATTRAZIONE: ogni cerchio è tirato verso la sua città
//     (i cerchi grandi più forte, così finiscono al centro della massa);
//   - COLLISIONE: i cerchi non si sovrappongono, si spingono via;
//   - CONFINI: ogni cerchio resta dentro la SUA regione
//     (niente mare, niente regioni vicine).
//  Le città vicine formano così un'unica massa continua che sfuma,
//  e i tipi di evento della stessa città restano raggruppati.
//
//  La grandezza dei singoli cerchi è solo grafica: il dato è l'area
//  della massa, cioè il numero di eventi.
//  Tutto si calcola una volta per anno, a uno zoom di riferimento:
//  poi le masse ingrandiscono con la mappa.
// ============================================================

const MASSE = {
  refZoom: 5,       // zoom a cui si calcola la disposizione (circa la vista Italia)
  fill: 0.42,       // quanto può riempirsi al massimo una regione (0-1), nell'anno più pieno.
                    // Da qui si ricava la grandezza dei cerchi, uguale per tutti gli anni.
  gap: 0.3,         // spazio tra i cerchi, in proporzione al raggio medio
  margin: 0.6,      // distanza minima dal confine, in proporzione al raggio medio
  steps: 200,       // passi della simulazione: più passi = più ordinato, ma più lento
  ink: "#9A0008",   // inchiostro principale (rosso scuro della style guide)
  ink2: "#D0222C",  // secondo inchiostro, per le proteste con intervento
};

// Nomi in italiano dei tipi ACLED. "ring: true" = disegnato come anello.
// "dir" = da che lato della città si mette quel gruppo (in gradi).
const TIPI = {
  "Peaceful protest":                  { label: "Proteste pacifiche",               color: MASSE.ink,  ring: false, dir: null },
  "Protest with intervention":         { label: "Proteste con intervento",          color: MASSE.ink2, ring: false, dir: 20 },
  "Excessive force against protesters":{ label: "Forza eccessiva sui manifestanti", color: MASSE.ink2, ring: true,  dir: 110 },
  "Violent demonstration":             { label: "Manifestazioni violente",          color: MASSE.ink,  ring: true,  dir: 200 },
  "Mob violence":                      { label: "Violenza di folla",                color: MASSE.ink,  ring: true,  dir: 290 },
};
const tipo = (t) => TIPI[t] || { label: t, color: MASSE.ink, ring: false, dir: 0 };

const masseCache = {}; // anno -> GeoJSON già calcolato
let regionFields = null; // per ogni regione: mappa delle distanze dal confine
let masseUnit = null;    // raggio medio dei cerchi (calcolato una volta)
const WORLD = () => 512 * Math.pow(2, MASSE.refZoom); // larghezza del mondo in px allo zoom di riferimento

// numeri casuali "fissi": stesso seme = stessi numeri a ogni ricarica
function seeded(str) {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// grandezza di un cerchio rispetto alla media: pochi grandi, tanti piccoli
const sizeFactor = (rnd) => 0.45 + 1.35 * Math.pow(rnd(), 2.2);
const MEAN_F2 = 0.62; // media di sizeFactor² (serve per stimare l'area occupata)

// ------------------------------------------------------------
//  CONFINI: per ogni regione una "mappa delle distanze".
//  Ogni pixel sa quanto dista dal confine (positivo dentro, negativo
//  fuori). Così basta una lettura per sapere se un cerchio sta uscendo
//  e da che parte spingerlo per farlo rientrare.
// ------------------------------------------------------------
const RES = 0.25; // un pixel della mappa delle distanze = 1/4 di px allo zoom di riferimento

function buildRegionFields() {
  const W = WORLD();
  regionFields = {};
  for (const f of REGIONS.features) {
    const g = f.geometry;
    const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates).map((poly) =>
      poly.map((ring) => ring.map(([lon, lat]) => {
        const m = maplibregl.MercatorCoordinate.fromLngLat([lon, lat]);
        return [m.x * W, m.y * W];
      })));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of polys) for (const [x, y] of poly[0]) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    x0 -= 4; y0 -= 4; x1 += 4; y1 += 4;
    const w = Math.ceil((x1 - x0) / RES), h = Math.ceil((y1 - y0) / RES);

    // 1) disegna la regione su una tela: bianco = dentro
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.setTransform(1 / RES, 0, 0, 1 / RES, -x0 / RES, -y0 / RES);
    ctx.beginPath();
    for (const poly of polys) for (const ring of poly) {
      ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    }
    ctx.fill("evenodd");
    const px = ctx.getImageData(0, 0, w, h).data;
    const inside = new Uint8Array(w * h);
    let count = 0;
    for (let i = 0; i < w * h; i++) if (px[i * 4 + 3] > 127) { inside[i] = 1; count++; }

    // 2) distanza di ogni pixel dal confine
    const dIn = distanceTransform(inside, w, h, 0);  // dentro: distanza dal fuori
    const dOut = distanceTransform(inside, w, h, 1); // fuori: distanza dal dentro
    const sdf = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) sdf[i] = (inside[i] ? Math.sqrt(dIn[i]) : -Math.sqrt(dOut[i])) * RES;

    regionFields[f.properties.name] = { x0, y0, w, h, sdf, area: count * RES * RES, polys };
  }
}

// Distanza (al quadrato) di ogni pixel dal pixel più vicino che vale "target".
// Algoritmo di Felzenszwalb: due passate, una per righe e una per colonne.
function distanceTransform(mask, w, h, target) {
  const INF = 1e20;
  const d = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] === target ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n), out = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const pass = (len) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s;
      do { const p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); } while (s <= z[k] && --k >= 0);
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const p = v[k]; out[q] = (q - p) * (q - p) + f[p]; }
  };
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = d[y * w + x]; pass(h); for (let y = 0; y < h; y++) d[y * w + x] = out[y]; }
  for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) f[x] = d[y * w + x]; pass(w); for (let x = 0; x < w; x++) d[y * w + x] = out[x]; }
  return d;
}

// distanza dal confine in un punto (px allo zoom di riferimento)
function sdfAt(F, x, y) {
  const i = Math.round((x - F.x0) / RES), j = Math.round((y - F.y0) / RES);
  if (i < 1 || j < 1 || i >= F.w - 1 || j >= F.h - 1) return -1e3;
  return F.sdf[j * F.w + i];
}
// direzione verso l'interno (gradiente della mappa delle distanze)
function inward(F, x, y) {
  const i = Math.round((x - F.x0) / RES), j = Math.round((y - F.y0) / RES);
  const at = (a, b) => F.sdf[Math.min(F.h - 1, Math.max(0, b)) * F.w + Math.min(F.w - 1, Math.max(0, a))];
  const gx = at(i + 1, j) - at(i - 1, j), gy = at(i, j + 1) - at(i, j - 1);
  const l = Math.hypot(gx, gy) || 1;
  return [gx / l, gy / l];
}

// regione che contiene un punto (per le righe con regione sconosciuta)
function regionOfPoint(x, y) {
  for (const [name, F] of Object.entries(regionFields)) if (sdfAt(F, x, y) > 0) return name;
  return null;
}

// ------------------------------------------------------------
//  Grandezza dei cerchi: scelta in modo che nell'anno più pieno
//  la regione più affollata sia piena al massimo per "fill".
//  È la stessa per tutti gli anni, così gli anni si confrontano.
// ------------------------------------------------------------
function computeUnit() {
  const counts = {}; // "anno|regione" -> eventi
  for (const r of ROWS) counts[r.anno + "|" + r.regione] = (counts[r.anno + "|" + r.regione] || 0) + r.n;
  let unit = Infinity;
  for (const [k, n] of Object.entries(counts)) {
    const F = regionFields[k.split("|")[1]];
    if (!F) continue;
    const perCircle = Math.PI * MEAN_F2 * Math.pow(1 + MASSE.gap, 2);
    unit = Math.min(unit, Math.sqrt((MASSE.fill * F.area) / (n * perCircle)));
  }
  return unit;
}

// ------------------------------------------------------------
//  Simulazione per l'anno selezionato
// ------------------------------------------------------------
function masseData() {
  if (masseCache[year]) return masseCache[year];
  if (!regionFields) buildRegionFields();
  if (!masseUnit) masseUnit = computeUnit();
  const u = masseUnit, W = WORLD();

  // 1. gruppi città + tipo, con il punto di attrazione
  const groups = {};
  const cityTotal = {};
  for (const r of ROWS) {
    if (r.anno !== year) continue;
    const city = r.lon + "," + r.lat;
    const key = city + "," + r.sub_event_type;
    if (!groups[key]) groups[key] = { key, city, lon: r.lon, lat: r.lat, regione: r.regione, type: r.sub_event_type, n: 0 };
    groups[key].n += r.n;
    cityTotal[city] = (cityTotal[city] || 0) + r.n;
  }

  // 2. un cerchio per evento, disposto all'inizio a spirale attorno alla città
  const nodes = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (const g of Object.values(groups)) {
    const m = maplibregl.MercatorCoordinate.fromLngLat([g.lon, g.lat]);
    let ax = m.x * W, ay = m.y * W;
    let reg = regionFields[g.regione] ? g.regione : regionOfPoint(ax, ay);
    if (!reg) continue;
    const t = tipo(g.type);
    // i tipi diversi dal principale si mettono a lato della massa della città
    if (t.dir !== null) {
      const off = Math.sqrt(cityTotal[g.city]) * u * 1.15;
      ax += Math.cos((t.dir * Math.PI) / 180) * off;
      ay += Math.sin((t.dir * Math.PI) / 180) * off;
    }
    const rnd = seeded(g.key + year);
    const radii = Array.from({ length: g.n }, () => u * sizeFactor(rnd)).sort((a, b) => b - a);
    radii.forEach((r, i) => {
      const d = 1.9 * u * Math.sqrt(i), a = i * golden;
      nodes.push({ x: ax + d * Math.cos(a), y: ay + d * Math.sin(a), ax, ay, r, F: regionFields[reg], g });
    });
  }
  if (!nodes.length) return (masseCache[year] = { type: "FeatureCollection", features: [] });

  // 3. simulazione (con array numerici: è la parte che deve essere veloce)
  const N = nodes.length;
  const X = new Float64Array(N), Y = new Float64Array(N), R = new Float64Array(N);
  const AX = new Float64Array(N), AY = new Float64Array(N);
  nodes.forEach((n, i) => { X[i] = n.x; Y[i] = n.y; R[i] = n.r; AX[i] = n.ax; AY[i] = n.ay; });
  const gap = u * MASSE.gap, margin = u * MASSE.margin;
  let rMax = 0;
  for (let i = 0; i < N; i++) rMax = Math.max(rMax, R[i]);
  const cell = 2 * rMax + gap;

  // griglia: ogni cerchio in una casella, così si confronta solo con i vicini
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (let i = 0; i < N; i++) { gx0 = Math.min(gx0, AX[i]); gx1 = Math.max(gx1, AX[i]); gy0 = Math.min(gy0, AY[i]); gy1 = Math.max(gy1, AY[i]); }
  gx0 -= 60; gy0 -= 60; gx1 += 60; gy1 += 60;
  const GW = Math.ceil((gx1 - gx0) / cell) + 1, GH = Math.ceil((gy1 - gy0) / cell) + 1;
  const head = new Int32Array(GW * GH), next = new Int32Array(N);
  const cellOf = (i) => {
    const cx = Math.min(GW - 1, Math.max(0, Math.floor((X[i] - gx0) / cell)));
    const cy = Math.min(GH - 1, Math.max(0, Math.floor((Y[i] - gy0) / cell)));
    return cy * GW + cx;
  };

  for (let step = 0; step < MASSE.steps; step++) {
    const alpha = 1 - step / MASSE.steps; // l'attrazione si spegne piano piano

    // a) attrazione verso la città: i cerchi grandi tirano di più
    for (let i = 0; i < N; i++) {
      const k = 0.035 * alpha * (0.4 + R[i] / rMax);
      X[i] += (AX[i] - X[i]) * k;
      Y[i] += (AY[i] - Y[i]) * k;
    }

    // b) collisioni
    head.fill(-1);
    for (let i = 0; i < N; i++) { const c = cellOf(i); next[i] = head[c]; head[c] = i; }
    for (let i = 0; i < N; i++) {
      const cx = Math.min(GW - 1, Math.max(0, Math.floor((X[i] - gx0) / cell)));
      const cy = Math.min(GH - 1, Math.max(0, Math.floor((Y[i] - gy0) / cell)));
      for (let dy = -1; dy <= 1; dy++) {
        const yy = cy + dy;
        if (yy < 0 || yy >= GH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = cx + dx;
          if (xx < 0 || xx >= GW) continue;
          for (let j = head[yy * GW + xx]; j !== -1; j = next[j]) {
            if (j <= i) continue;
            let vx = X[j] - X[i], vy = Y[j] - Y[i];
            const min = R[i] + R[j] + gap;
            const d2 = vx * vx + vy * vy;
            if (d2 >= min * min) continue;
            let d = Math.sqrt(d2);
            if (d < 1e-9) { const an = (i * 2.399) % 6.283; vx = Math.cos(an); vy = Math.sin(an); d = 1; }
            const push = (min - d) / d;
            const ri = R[i] * R[i], rj = R[j] * R[j];
            const wi = rj / (ri + rj); // il cerchio piccolo si sposta di più
            X[i] -= vx * push * wi;       Y[i] -= vy * push * wi;
            X[j] += vx * push * (1 - wi); Y[j] += vy * push * (1 - wi);
          }
        }
      }
    }

    // c) confini: chi esce (o tocca il bordo) viene rimesso dentro la sua regione
    for (let i = 0; i < N; i++) {
      const F = nodes[i].F;
      const need = R[i] + margin;
      const d = sdfAt(F, X[i], Y[i]);
      if (d >= need) continue;
      if (d < -50) { X[i] = AX[i]; Y[i] = AY[i]; continue; } // finito lontanissimo: torna alla città
      const [gx, gy] = inward(F, X[i], Y[i]);
      X[i] += gx * (need - d);
      Y[i] += gy * (need - d);
    }
  }
  nodes.forEach((n, i) => { n.x = X[i]; n.y = Y[i]; });

  // 4. ogni cerchio diventa un punto GeoJSON
  const scale = Math.pow(2, MASSE.refZoom);
  const features = nodes.map((n) => {
    const t = tipo(n.g.type);
    const ll = new maplibregl.MercatorCoordinate(n.x / W, n.y / W).toLngLat();
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [ll.lng, ll.lat] },
      properties: {
        r0: n.r / scale, // raggio a zoom 0 (lo stile lo moltiplica per 2^zoom)
        color: t.color, ring: t.ring,
        label: t.label, n: n.g.n, regione: n.g.regione,
      },
    };
  });
  return (masseCache[year] = { type: "FeatureCollection", features });
}

// --- sorgente e layer ---
function addMasseLayer() {
  map.addSource("masse", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // il raggio raddoppia a ogni livello di zoom, come la mappa
  const radius = ["interpolate", ["exponential", 2], ["zoom"],
    0, ["get", "r0"],
    22, ["*", ["get", "r0"], 4194304]]; // 4194304 = 2^22
  map.addLayer({
    id: "masse", type: "circle", source: "masse",
    paint: {
      "circle-radius": radius,
      "circle-color": ["case", ["get", "ring"], "rgba(0,0,0,0)", ["get", "color"]],
      // gli anelli: bordo spesso un terzo del raggio
      // (lo zoom deve stare all'esterno dell'espressione: il "case" va dentro ogni tappa)
      "circle-stroke-color": ["get", "color"],
      "circle-stroke-width": ["interpolate", ["exponential", 2], ["zoom"],
        0, ["case", ["get", "ring"], ["*", ["get", "r0"], 0.35], 0],
        22, ["case", ["get", "ring"], ["*", ["get", "r0"], 0.35 * 4194304], 0]],
      "circle-pitch-alignment": "map",
    },
  });
}

function refreshMasse() {
  const src = map.getSource("masse");
  if (src) src.setData(masseData());
}

// con una regione aperta si vedono solo le sue masse
function filterMasse(regione) {
  map.setFilter("masse", regione ? ["==", ["get", "regione"], regione] : null);
}
