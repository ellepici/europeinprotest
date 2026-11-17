let ROWS;  // le righe del CSV, trasformate in oggetti { lon, lat, anno, ... }
let YEARS; // gli anni presenti nei dati
let map;   // MapLibre
let year;  // l'anno selezionato in questo momento

Promise.all([
  fetch("../data/italy.csv").then((r) => r.text()),            
  fetch("../data/italy_regions.min.geojson").then((r) => r.json()), // i confini sono GeoJSON
  fetch("../data/neighbors.geojson").then((r) => r.json()),         // i paesi intorno (rosa nel wireframe)
]).then(([csvText, regions, neighbors]) => {
  ROWS = parseCSV(csvText);
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
function pointsOfYear() {
  const byPlace = {}; // es. { "12.49,41.89": 303, "7.67,45.07": 270, ... }

  for (const r of ROWS) {
    if (r.anno !== year) continue;         // salta gli altri anni
    const k = r.lon + "," + r.lat;         // le coordinate fanno da "chiave"
    byPlace[k] = (byPlace[k] || 0) + r.n;  // somma gli eventi in quel luogo
  }

  const max = Math.max(...Object.values(byPlace));

  return {
    type: "FeatureCollection",
    features: Object.entries(byPlace).map(([k, n]) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: k.split(",").map(Number) },
      properties: { w: Math.log1p(n) / Math.log1p(max) },
    })),
  };
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
    bounds: [[6.4, 36.4], [18.8, 47.2]],
    // spazio libero ai lati: a sinistra la timeline, a destra il passaporto
    fitBoundsOptions: { padding: { top: 60, bottom: 40, left: 120, right: window.innerWidth * 0.42 } },
    attributionControl: { compact: true, customAttribution: "Confini: ISTAT/openpolis, Natural Earth · Dati: ACLED" },
  });

  map.on("load", () => {
    // SOURCE = i dati. LAYER = come disegnarli.
    map.addSource("neighbors", { type: "geojson", data: neighbors });
    map.addSource("regions", { type: "geojson", data: regions });
    map.addSource("events", { type: "geojson", data: pointsOfYear() });

    // I layer si disegnano uno sopra l'altro, nell'ordine in cui li aggiungi.

    // a) I paesi vicini, rosa spento, con i confini un po' più chiari
    map.addLayer({ id: "neighbors", type: "fill", source: "neighbors", paint: { "fill-color": "#ad5e61" } });
    map.addLayer({ id: "neighbors-line", type: "line", source: "neighbors", paint: { "line-color": "#c98a8c", "line-width": 0.8 } });

    // b) L'Italia bianca (le regioni)
    map.addLayer({ id: "regions", type: "fill", source: "regions", paint: { "fill-color": "#FFFFFF" } });

    // c) La heatmap degli eventi: macchie rosse sul bianco
    map.addLayer({
      id: "heat", type: "heatmap", source: "events",
      paint: {
        // quanto conta ogni punto: il peso "w" calcolato in pointsOfYear()
        "heatmap-weight": ["get", "w"],
        // raggio delle macchie: più zoomi, più si allargano (8px a zoom 5, 30px a zoom 9)
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 5, 8, 9, 30],
        // intensità: più alta = macchie più scure, come i pallini del wireframe
        "heatmap-intensity": 1.6,
        // colori in base alla densità: trasparente → rosso chiaro → rosso → rosso scurissimo
        "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
          0, "rgba(208,34,44,0)", 0.1, "rgba(208,34,44,0.6)", 0.3, "#D0222C", 0.7, "#720000"],
      },
    });

    // d) I confini delle regioni, sottili, sopra la heatmap così si vedono sempre
    map.addLayer({ id: "borders", type: "line", source: "regions", paint: { "line-color": "#D0222C", "line-opacity": 0.25, "line-width": 0.6 } });

    // --- HOVER: riquadro con nome della regione e numero di eventi ---
    const tip = document.getElementById("tooltip");

    // Quando il mouse si muove SOPRA il layer "regions"...
    map.on("mousemove", "regions", (e) => {
      const name = e.features[0].properties.name; // regione sotto il mouse
      // split("/")[0] accorcia "Valle d'Aosta/Vallée d'Aoste" in "Valle d'Aosta"
      tip.innerHTML = `<b>${name.split("/")[0]}</b><br>${regionTotal(name)} eventi nel ${year}`;
      // mette il riquadro vicino al mouse (e.point = posizione nella mappa)
      tip.style.left = e.point.x + "px";
      tip.style.top = e.point.y + map.getContainer().offsetTop + "px";
      tip.hidden = false;
    });

    // ...e quando esce dalle regioni (va sul mare) lo nasconde.
    map.on("mouseleave", "regions", () => (tip.hidden = true));

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
  document.querySelectorAll(".years button").forEach((b) => b.classList.toggle("on", +b.textContent === year));

  // sostituisce i punti della heatmap con quelli del nuovo anno
  map.getSource("events")?.setData(pointsOfYear());

  // totale eventi dell'anno, mostrato nel passaporto
  const tot = ROWS.filter((r) => r.anno === year).reduce((s, r) => s + r.n, 0);
  document.getElementById("y").textContent = year;
  document.getElementById("tot").textContent = tot;
}
