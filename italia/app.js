let ROWS;  // le righe del CSV, trasformate in oggetti { lon, lat, anno, ... }
let YEARS; // gli anni presenti nei dati
let map;   // MapLibre
let year;  // l'anno selezionato in questo momento
let REGIONS;        // il GeoJSON delle regioni (serve per calcolare il riquadro di ognuna)
let hovered = null; // nome della regione sotto il mouse
let selected = null; // nome della regione aperta (null = vista di tutta l'Italia)

// Riquadro [ovest, sud], [est, nord] di tutta l'Italia
const ITALY = [[6.4, 36.4], [18.8, 47.2]];

// Spazio libero ai lati della mappa: a sinistra la timeline, a destra il passaporto.
// È una funzione perché dipende dalla larghezza della finestra in quel momento.
function pad() {
  return { top: 60, bottom: 40, left: 120, right: window.innerWidth * 0.42 };
}

Promise.all([
  fetch("../data/italy.csv").then((r) => r.text()),            
  fetch("../data/italy_regions.min.geojson").then((r) => r.json()), // i confini sono GeoJSON
  fetch("../data/neighbors.geojson").then((r) => r.json()),         // i paesi intorno (rosa nel wireframe)
]).then(([csvText, regions, neighbors]) => {
  ROWS = parseCSV(csvText);
  REGIONS = regions;
  // anni unici, in ordine: new Set toglie i doppioni
  YEARS = [...new Set(ROWS.map((r) => r.anno))].sort();
  year = YEARS[YEARS.length - 1]; // parte dall'ultimo anno (2025)
  drawYears();       // crea i bottoni degli anni
  drawMap(regions, neighbors);  // crea la mappa
});


function parseCSV(text) {
  // \r?\n = va a capo sia con file Mac/Linux (\n) sia Windows/Excel (\r\n)
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(","); // la prima riga sono i nomi delle colonne
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const row = {};
    header.forEach((col, i) => (row[col] = values[i]));
    // i numeri nel CSV sono testo: li convertiamo
    row.lon = +row.lon;
    row.lat = +row.lat;
    row.anno = +row.anno;
    row.n = +row.n;
    return row;
  });
}
function regionTotal(name) {
  let tot = 0;
  for (const r of ROWS) {
    if (r.anno === year && r.regione === name) tot += r.n;
  }
  return tot;
}

function drawMap(regions, neighbors) {
  map = new maplibregl.Map({
    container: "map", // l'id del <div> in index.html
    style: {
      version: 8,
      sources: {},
      // il fondo è il mare, rosso scuro come nel wireframe
      layers: [{ id: "bg", type: "background", paint: { "background-color": "#680108" } }],
    },
    // Riquadro [ovest, sud], [est, nord] che deve stare tutto nello schermo:
    bounds: ITALY,
    fitBoundsOptions: { padding: pad() },
    attributionControl: { compact: true, customAttribution: "Confini: ISTAT/openpolis, Natural Earth · Dati: ACLED" },
  });

  map.on("load", () => {
    // SOURCE = i dati. LAYER = come disegnarli.
    map.addSource("neighbors", { type: "geojson", data: neighbors });
    map.addSource("regions", { type: "geojson", data: regions, promoteId: "name" });

    // I layer si disegnano uno sopra l'altro, nell'ordine in cui li aggiungi.

    // a) I paesi vicini, rosa spento, con i confini un po' più chiari
    map.addLayer({ id: "neighbors", type: "fill", source: "neighbors", paint: { "fill-color": "#ad5e61" } });
    map.addLayer({ id: "neighbors-line", type: "line", source: "neighbors", paint: { "line-color": "#c98a8c", "line-width": 0.8 } });

    // b) L'Italia bianca (le regioni)
    map.addLayer({ id: "regions", type: "fill", source: "regions", paint: { "fill-color": "#FFFFFF" } });

    // c) Le masse degli eventi: cerchi impacchettati per città e tipo (vedi masse.js)
    addMasseLayer();

    // d) I confini delle regioni, sottili, sopra il retino così si vedono sempre
    map.addLayer({ id: "borders", type: "line", source: "regions", paint: { "line-color": "#D0222C", "line-opacity": 0.25, "line-width": 0.6 } });

    // e) Quando una regione è aperta, le altre vengono velate col colore del mare.
    //    Il filtro dice quali regioni coprire: all'inizio nessuna.
    map.addLayer({
      id: "dim", type: "fill", source: "regions",
      filter: ["==", ["get", "name"], ""],
      paint: { "fill-color": "#680108", "fill-opacity": 0.55 },
    });

    // f) Contorno della regione sotto il mouse o aperta.
    //    "feature-state" è uno stato che cambiamo da JS (hover / selected) senza ridisegnare i dati.
    const hot = ["any",
      ["boolean", ["feature-state", "hover"], false],
      ["boolean", ["feature-state", "selected"], false]];
    map.addLayer({
      id: "region-outline", type: "line", source: "regions",
      layout: { "line-join": "round" },
      paint: {
        "line-color": "#D0222C",
        "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 2.5, 2],
        "line-opacity": ["case", hot, 1, 0],
      },
    });

    // --- HOVER: riquadro con nome della regione e numero di eventi ---
    const tip = document.getElementById("tooltip");

    // Quando il mouse si muove SOPRA il layer "regions"...
    map.on("mousemove", "regions", (e) => {
      const name = e.features[0].properties.name; // regione sotto il mouse
      setHover(name);
      map.getCanvas().style.cursor = "pointer";
      // split("/")[0] accorcia "Valle d'Aosta/Vallée d'Aoste" in "Valle d'Aosta"
      tip.innerHTML = `<b>${name.split("/")[0]}</b><br>${regionTotal(name)} eventi nel ${year}`;
      // se il mouse è sopra una massa, mostra anche il tipo e quanti eventi contiene
      const m = map.queryRenderedFeatures(e.point, { layers: ["masse"] })[0];
      if (m) tip.innerHTML += `<br>${m.properties.label}: ${m.properties.n}`;
      // mette il riquadro vicino al mouse (e.point = posizione nella mappa)
      tip.style.left = e.point.x + "px";
      tip.style.top = e.point.y + map.getContainer().offsetTop + "px";
      tip.hidden = false;
    });

    // ...e quando esce dalle regioni (va sul mare) lo nasconde.
    map.on("mouseleave", "regions", () => {
      tip.hidden = true;
      setHover(null);
      map.getCanvas().style.cursor = "";
    });

    // --- CLIC: apre la regione (zoom per farla stare tutta nello schermo) ---
    // Clic su un'altra regione = passa a quella. Clic sulla stessa, sul mare
    // o sui paesi vicini = torna a tutta l'Italia. Anche il tasto Esc torna indietro.
    map.on("click", (e) => {
      const f = map.queryRenderedFeatures(e.point, { layers: ["regions"] })[0];
      const name = f ? f.properties.name : null;
      if (!name || name === selected) selectRegion(null);
      else selectRegion(name);
    });
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") selectRegion(null); });

    // se la finestra cambia dimensione, rifà l'inquadratura
    window.addEventListener("resize", () => fit(false));

    update(); // primo disegno con l'anno di partenza
  });
}

function drawYears() {
  const box = document.getElementById("years");
  for (const y of YEARS) {
    const b = document.createElement("button");
    b.textContent = y;
    b.onclick = () => { year = y; update(); };
    box.appendChild(b);
  }
}

function update() {
  // evidenzia il bottone dell'anno attivo (classe CSS "on")
  document.querySelectorAll("#years button").forEach((b) => b.classList.toggle("on", +b.textContent === year));

  // ridisegna le masse con gli eventi del nuovo anno
  refreshMasse();

  // totale eventi dell'anno, mostrato nel passaporto
  const tot = ROWS.filter((r) => r.anno === year).reduce((s, r) => s + r.n, 0);
  document.getElementById("y").textContent = year;
  document.getElementById("tot").textContent = tot;
}


// ---------- REGIONI: hover, selezione e zoom ----------

// Accende il contorno della regione sotto il mouse (e spegne quella di prima)
function setHover(name) {
  if (hovered === name) return;
  if (hovered) map.setFeatureState({ source: "regions", id: hovered }, { hover: false });
  if (name) map.setFeatureState({ source: "regions", id: name }, { hover: true });
  hovered = name;
}

// Apre una regione (name) oppure torna a tutta l'Italia (null)
function selectRegion(name) {
  if (selected) map.setFeatureState({ source: "regions", id: selected }, { selected: false });
  selected = name;
  if (name) map.setFeatureState({ source: "regions", id: name }, { selected: true });

  // vela tutte le regioni tranne quella aperta; senza selezione non vela niente
  map.setFilter("dim", name ? ["!=", ["get", "name"], name] : ["==", ["get", "name"], ""]);
  filterMasse(name);
  fit(true);
}

// Inquadra la regione aperta, o tutta l'Italia, dentro lo spazio libero dello schermo
function fit(animate) {
  const box = selected ? regionBounds(selected) : ITALY;
  map.fitBounds(box, { padding: pad(), duration: animate ? 900 : 0, maxZoom: 10 });
}

// Riquadro [[ovest, sud], [est, nord]] di una regione, calcolato dal GeoJSON.
// Le isolette piccole (es. Lampedusa per la Sicilia) non contano,
// altrimenti la regione verrebbe rimpicciolita per farle entrare nello schermo.
function regionBounds(name) {
  const f = REGIONS.features.find((f) => f.properties.name === name);
  const g = f.geometry;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;

  // riquadro e area (approssimata) di ogni pezzo della regione
  const parts = polys.map((poly) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of poly[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    return { w, s, e, n, area: (e - w) * (n - s) };
  });
  const biggest = Math.max(...parts.map((p) => p.area));
  const kept = parts.filter((p) => p.area >= biggest * 0.02); // tiene i pezzi grandi almeno il 2% del principale

  return [
    [Math.min(...kept.map((p) => p.w)), Math.min(...kept.map((p) => p.s))],
    [Math.max(...kept.map((p) => p.e)), Math.max(...kept.map((p) => p.n))],
  ];
}
