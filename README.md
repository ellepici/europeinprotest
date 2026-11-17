# Europe in Protest

Progetto del Laboratorio di Computergrafica per l'Information Design (C2, PoliMi), gruppo 9.
Sito di data visualization (solo desktop) sulle proteste e rivolte in Europa, dati ACLED 2020–2025.

## Struttura

```
italia/                  vista Stato (Italia): mappa heatmap + passaporto   ← branch nicola
data/italy.csv           dati ACLED aggregati per l'Italia (generato, si apre con Excel)
data/italy_regions*.geojson  confini regionali ISTAT / openpolis
scripts/prepare_italy.py aggrega il dataset ACLED → data/italy.csv
scripts/prepare_neighbors.py ritaglia i paesi vicini (Natural Earth) → data/neighbors.geojson
data/raw/                dataset ACLED grezzo (NON su git)
```

## Avviare in locale

Le pagine caricano i dati con `fetch`, quindi serve un server (non basta aprire il file):

```bash
python3 -m http.server 8000
```

poi apri http://localhost:8000/italia/

## Rigenerare i dati

1. Scarica l'xlsx ACLED dal Drive del gruppo e mettilo in `data/raw/` (è in `.gitignore`).
2. `pip install openpyxl`
3. `python3 scripts/prepare_italy.py data/raw/ACLED.xlsx`

Lo script non toglie righe: **aggrega** (indicazione del prof). Gli eventi con le stesse coordinate,
lo stesso anno e lo stesso tipo diventano un solo punto con un conteggio, che è il peso della heatmap.
Così si risolve anche il problema delle coordinate duplicate (centroidi delle città).

## Dati e licenza

I termini d'uso ACLED vietano di ripubblicare i dati grezzi: nella repo ci sono solo dati aggregati,
e il sito resta un progetto d'esame, da non pubblicare online.

## Bozza vista Italia: cosa c'è

Segue il WIREFRAME 4 del Figma "ACLED – wireframe".

- Mappa MapLibre GL JS a schermo intero: mare rosso scuro, paesi vicini rosa, Italia bianca.
- Heatmap degli eventi ACLED reali, macchie rosse sul bianco (scala logaritmica,
  così Roma e Milano non coprono il resto).
- Timeline verticale a sinistra: un anno alla volta.
- Hover su una regione: nome e numero di eventi nell'anno.
- Passaporto che esce dal bordo destro: solo struttura, i timbri sono segnaposto.
- Font della Style Guide (Veneer, Typeka) caricati da un kit Adobe Fonts (`pvj4rxm`), valido
  solo su `localhost`. Altrove si vedono le riserve Oswald e Special Elite: per un altro dominio
  va aggiunto al kit su fonts.adobe.com.
