"""
Ritaglia i paesi intorno all'Italia (sfondo della vista Stato, come nel wireframe).

Fonte: Natural Earth, confini dei paesi 1:50m (open data).
Output: data/neighbors.geojson

Uso:
  python scripts/prepare_neighbors.py
"""

import json
import urllib.request
from pathlib import Path

URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
       "master/geojson/ne_50m_admin_0_countries.geojson")
OUT = Path(__file__).resolve().parent.parent / "data" / "neighbors.geojson"

# area visibile intorno all'Italia: [ovest, sud, est, nord]
BBOX = (-2, 32, 26, 52)
# Italia, San Marino e Vaticano restano fuori: l'Italia la disegnano le regioni
SKIP = {"ITA", "SMR", "VAT"}


def coords_of(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        for ring in poly:
            yield from ring


def touches_bbox(geom):
    return any(BBOX[0] <= x <= BBOX[2] and BBOX[1] <= y <= BBOX[3] for x, y in coords_of(geom))


def round_geom(geom):
    def ring(r):
        out = []
        for x, y in r:
            p = [round(x, 3), round(y, 3)]
            if not out or out[-1] != p:
                out.append(p)
        return out
    if geom["type"] == "Polygon":
        geom["coordinates"] = [ring(r) for r in geom["coordinates"]]
    else:
        geom["coordinates"] = [[ring(r) for r in poly] for poly in geom["coordinates"]]
    return geom


def main():
    with urllib.request.urlopen(URL) as r:
        world = json.load(r)
    features = []
    for f in world["features"]:
        iso = f["properties"].get("ADM0_A3")
        if iso in SKIP or not touches_bbox(f["geometry"]):
            continue
        features.append({
            "type": "Feature",
            "properties": {"name": f["properties"].get("NAME_IT") or f["properties"].get("NAME")},
            "geometry": round_geom(f["geometry"]),
        })
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
    print(f"{len(features)} paesi -> {OUT.name} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
