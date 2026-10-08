# Harbor Motion

A map of boat traffic across **New York Harbor and its surrounding waterways and ports**,
drawn over the working **NOAA nautical chart**.

- **Year** — a density heatmap of a full real year (2025) of NOAA Marine Cadastre AIS data,
  showing where traffic concentrates; filterable by vessel type, with counts.
- **A day** — the most recent complete day, as a scrubbable animation or a whole-day map.
- **Live** — true real-time positions from [AISStream.io](https://aisstream.io), relayed
  through a Cloudflare Worker that keeps the API key secret; vessels leave fading radar wakes.

Built with [MapLibre GL](https://maplibre.org/) + [deck.gl](https://deck.gl/) over the
NOAA ENC Maritime Chart Service. See [methodology.html](methodology.html) for data sources,
the harbor bounding box, sampling, vessel-type mapping and limitations.

## Rebuilding the data

```bash
python3 -m venv .venv && .venv/bin/pip install zstandard pandas pyarrow requests
.venv/bin/python pipeline/download_filter.py 2025-01-01 2025-12-31   # filter to the harbor
.venv/bin/python pipeline/build_heat.py        # year density grid  -> data/web/heat.json
.venv/bin/python pipeline/add_counts.py        # per-type counts    -> manifest.json
.venv/bin/python pipeline/build_day.py         # latest complete day -> data/web/day.json
```

## Live relay (Cloudflare Worker)

```bash
cd worker
npx wrangler secret put AISSTREAM_KEY   # paste your free aisstream.io key
npx wrangler deploy
```

The relay passes AISStream's own error messages (such as a rejected key) to the page
and the recorder, so a bad key no longer looks the same as an outage.

## Recorder (rolling recent history)

`recorder/loop.mjs` runs as one long GitHub Actions job (`.github/workflows/record.yml`).
Every 15 minutes it listens to the relay for 30 seconds and appends the vessels it saw to
`data/recent/YYYY-MM-DD.jsonl` on the **`data` branch** (not main: every push to main
rebuilds Pages, and the site doesn't read these files). An empty snapshot is never
recorded, since New York Harbor is never empty. Before GitHub's 6-hour job limit the
loop dispatches its own successor; the hourly cron is only a backstop, because from
Oct. 1, 2026 GitHub started only about five of the old 15-minute cron runs a day.

*Not for navigation.* Chart: NOAA ENC®. Tracks: AIS.
