"""
Prepara i dati aggregati per la vista Stato (Italia).

Input:  data/raw/<file ACLED>.xlsx  (NON va su git: termini d'uso ACLED)
Output: data/italy.csv              (solo dati aggregati, niente righe grezze)

Seguendo l'indicazione del prof ("meglio aggregare che filtrare") non si
scarta nessuna riga dell'Italia: gli eventi vengono contati e raggruppati.

Ogni riga del CSV e' un gruppo di eventi con stesse coordinate, stesso anno
e stesso tipo; la colonna n dice quanti sono (= peso nella heatmap).
Risolve le coordinate duplicate (centroidi ACLED): invece di 100 puntini
sovrapposti c'e' una sola riga con n = 100.

  lon,lat,anno,regione,event_type,sub_event_type,n
  12.4906,41.8894,2021,Lazio,Protests,Peaceful protest,303

Uso:
  python scripts/prepare_italy.py data/raw/ACLED.xlsx
"""

import csv
import json
import sys
from collections import Counter
from pathlib import Path

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "italy.csv"
REGIONS_IN = ROOT / "data" / "italy_regions.geojson"
REGIONS_OUT = ROOT / "data" / "italy_regions.min.geojson"

COUNTRY = "Italy"

# admin1 ACLED (inglese) -> reg_name del GeoJSON openpolis/ISTAT
ADMIN1_TO_REG = {
    "Abruzzo": "Abruzzo",
    "Aosta Valley": "Valle d'Aosta/Vallée d'Aoste",
    "Valle d'Aosta": "Valle d'Aosta/Vallée d'Aoste",
    "Apulia": "Puglia",
    "Puglia": "Puglia",
    "Basilicata": "Basilicata",
    "Calabria": "Calabria",
    "Campania": "Campania",
    "Emilia-Romagna": "Emilia-Romagna",
    "Friuli-Venezia Giulia": "Friuli-Venezia Giulia",
    "Friuli Venezia Giulia": "Friuli-Venezia Giulia",
    "Lazio": "Lazio",
    "Liguria": "Liguria",
    "Lombardy": "Lombardia",
    "Lombardia": "Lombardia",
    "Marche": "Marche",
    "Molise": "Molise",
    "Piedmont": "Piemonte",
    "Piemonte": "Piemonte",
    "Sardinia": "Sardegna",
    "Sardegna": "Sardegna",
    "Sicily": "Sicilia",
    "Sicilia": "Sicilia",
    "Tuscany": "Toscana",
    "Toscana": "Toscana",
    "Trentino-Alto Adige": "Trentino-Alto Adige/Südtirol",
    "Trentino-South Tyrol": "Trentino-Alto Adige/Südtirol",
    "Trentino Alto Adige": "Trentino-Alto Adige/Südtirol",
    "Umbria": "Umbria",
    "Veneto": "Veneto",
}


def to_int(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def to_float(v):
    try:
        return float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None


def read_rows(path):
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = ws.iter_rows(values_only=True)
    header = [str(h).strip() if h is not None else "" for h in next(rows)]
    idx = {h: i for i, h in enumerate(header)}
    for r in rows:
        yield {h: r[i] if i < len(r) else None for h, i in idx.items()}


def simplify_regions():
    """Arrotonda le coordinate a 3 decimali (~100 m) e toglie i punti
    consecutivi duplicati: da ~2.7 MB a qualche centinaio di KB."""
    gj = json.loads(REGIONS_IN.read_text())

    def ring(r):
        out = []
        for x, y in r:
            p = [round(x, 3), round(y, 3)]
            if not out or out[-1] != p:
                out.append(p)
        if out[0] != out[-1]:
            out.append(out[0])
        return out if len(out) >= 4 else None

    for f in gj["features"]:
        g = f["geometry"]
        if g["type"] == "Polygon":
            g["coordinates"] = [x for x in (ring(r) for r in g["coordinates"]) if x]
        else:
            polys = []
            for poly in g["coordinates"]:
                rings = [x for x in (ring(r) for r in poly) if x]
                if rings:
                    polys.append(rings)
            g["coordinates"] = polys
        f["properties"] = {"name": f["properties"]["reg_name"]}
    gj.pop("bbox", None)
    REGIONS_OUT.write_text(json.dumps(gj, separators=(",", ":")))


def main(src):
    groups = Counter()  # (lon, lat, anno, regione, event_type, sub_event_type) -> n
    unmatched = Counter()
    years = set()
    total = 0
    countries = Counter()

    for row in read_rows(src):
        countries[row.get("country")] += 1
        if row.get("country") != COUNTRY:
            continue
        lat, lon = to_float(row.get("latitude")), to_float(row.get("longitude"))
        year = to_int(row.get("year"))
        if lat is None or lon is None or not year:
            unmatched["<coordinate/anno mancanti>"] += 1
            continue
        etype = row.get("event_type") or "?"
        sub = row.get("sub_event_type") or "?"
        admin1 = (row.get("admin1") or "").strip()
        reg = ADMIN1_TO_REG.get(admin1)
        if reg is None:
            unmatched[admin1] += 1
            reg = admin1 or "?"

        total += 1
        years.add(year)
        groups[(round(lon, 4), round(lat, 4), year, reg, etype, sub)] += 1

    if total == 0:
        print("Nessun evento per", COUNTRY, "- paesi trovati:", countries.most_common(10))
        sys.exit(1)

    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["lon", "lat", "anno", "regione", "event_type", "sub_event_type", "n"])
        for key, n in sorted(groups.items(), key=lambda kv: (kv[0][2], -kv[1])):
            w.writerow([*key, n])
    simplify_regions()

    print(f"Eventi Italia: {total}  | righe aggregate: {len(groups)}  | anni: {sorted(years)}")
    print(f"Scritto {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")
    print(f"Scritto {REGIONS_OUT.relative_to(ROOT)} ({REGIONS_OUT.stat().st_size // 1024} KB)")
    if unmatched:
        print("admin1 non riconosciuti (da aggiungere a ADMIN1_TO_REG):", dict(unmatched))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
