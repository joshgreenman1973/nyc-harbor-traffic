"""Download NOAA Marine Cadastre daily AIS files, filter to the NYC harbor
bounding box, and write one compact Parquet per day.

The national daily file (~230 MB compressed, multi-GB uncompressed) is streamed
and decompressed on the fly -- it is NEVER written to disk. Only the harbor
subset (a few MB/day) is persisted. Safe to re-run: existing day files are skipped.

Usage:
    python pipeline/download_filter.py 2025-06-01 2025-06-30
    python pipeline/download_filter.py 2025-01-01 2025-12-31   # full year
"""
import io
import sys
import os
import datetime as dt

import requests
import zstandard
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from harbor import (
    LON_MIN, LON_MAX, LAT_MIN, LAT_MAX, KEEP_COLS, category_for, noaa_url,
)

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "days")
CHUNK = 500_000  # CSV rows per pandas chunk

DTYPES = {
    "mmsi": "int64", "longitude": "float32", "latitude": "float32",
    "sog": "float32", "cog": "float32", "heading": "float32",
    "vessel_name": "string", "vessel_type": "string",
}


def daterange(start, end):
    d, end = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    while d <= end:
        yield d.isoformat()
        d += dt.timedelta(days=1)


def process_day(date_str):
    out_path = os.path.join(OUT_DIR, f"ais-{date_str}.parquet")
    if os.path.exists(out_path):
        print(f"  {date_str}: already done, skipping")
        return
    url = noaa_url(date_str)
    r = requests.get(url, stream=True, timeout=120)
    if r.status_code != 200:
        print(f"  {date_str}: HTTP {r.status_code}, skipping")
        return
    dctx = zstandard.ZstdDecompressor()
    reader = dctx.stream_reader(r.raw)
    text = io.TextIOWrapper(reader, encoding="utf-8", errors="replace")

    kept = []
    rows_in = 0
    for chunk in pd.read_csv(
        text, usecols=KEEP_COLS, dtype=DTYPES, chunksize=CHUNK,
        on_bad_lines="skip",
    ):
        rows_in += len(chunk)
        m = (
            (chunk.longitude >= LON_MIN) & (chunk.longitude <= LON_MAX)
            & (chunk.latitude >= LAT_MIN) & (chunk.latitude <= LAT_MAX)
        )
        sub = chunk[m]
        if len(sub):
            kept.append(sub)
    r.close()

    if not kept:
        print(f"  {date_str}: 0 harbor rows (of {rows_in:,})")
        return
    df = pd.concat(kept, ignore_index=True)
    df["category"] = df["vessel_type"].map(category_for).astype("category")
    df["t"] = pd.to_datetime(df["base_date_time"], errors="coerce")
    df = df.drop(columns=["base_date_time"]).dropna(subset=["t"])
    df = df.sort_values(["mmsi", "t"])
    df.to_parquet(out_path, index=False)
    print(f"  {date_str}: {len(df):,} harbor rows (of {rows_in:,}), "
          f"{df.mmsi.nunique():,} vessels -> {os.path.basename(out_path)}")


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    os.makedirs(OUT_DIR, exist_ok=True)
    start, end = sys.argv[1], sys.argv[2]
    days = list(daterange(start, end))
    print(f"Processing {len(days)} day(s) {start} .. {end}")
    for i, date_str in enumerate(days, 1):
        print(f"[{i}/{len(days)}] {date_str}")
        try:
            process_day(date_str)
        except Exception as e:  # keep going on a bad day
            print(f"  {date_str}: ERROR {e!r}")


if __name__ == "__main__":
    main()
