# Harbor Motion

An animated map of boat traffic across **all five boroughs of New York City**, drawn over
the working **NOAA nautical chart**.

- **Year replay** — a real year (2025) of vessel movements from NOAA Marine Cadastre AIS data,
  time-compressed with fading trails, color-coded by vessel type.
- **Live** — true real-time positions from [AISStream.io](https://aisstream.io), relayed
  through a Cloudflare Worker that keeps the API key secret.

Built with [MapLibre GL](https://maplibre.org/) + [deck.gl](https://deck.gl/) over the
NOAA ENC Maritime Chart Service. See [methodology.html](methodology.html) for data sources,
the harbor bounding box, sampling, vessel-type mapping and limitations.

## Rebuilding the data

```bash
python3 -m venv .venv && .venv/bin/pip install zstandard pandas pyarrow requests
.venv/bin/python pipeline/download_filter.py 2025-01-01 2025-12-31   # filter to the harbor
.venv/bin/python pipeline/build_web_bundle.py                        # -> data/web/
```

## Live relay (Cloudflare Worker)

```bash
cd worker
npx wrangler secret put AISSTREAM_KEY   # paste your free aisstream.io key
npx wrangler deploy
```

*Not for navigation.* Chart: NOAA ENC®. Tracks: AIS.
