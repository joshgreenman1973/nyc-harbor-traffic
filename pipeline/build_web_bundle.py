"""Turn filtered day Parquets into compact deck.gl TripsLayer JSON, one file
per month, plus a manifest.

Each vessel's positions are downsampled to ~SAMPLE_MINUTES and split into
separate trip segments whenever there is a gap longer than GAP_MINUTES (so the
animation never draws a straight "teleport" line across the harbor).

Output (data/web/):
    manifest.json          -- months, categories, colors, bbox, counts
    trips-2025-MM.json     -- [{c: catIdx, p: [[lng,lat]..], t: [epochSec..]}, ..]

Usage:
    python pipeline/build_web_bundle.py            # all months found
    python pipeline/build_web_bundle.py 2025-06    # one month
"""
import os
import sys
import glob
import json
import math

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from harbor import CATEGORIES, LON_MIN, LON_MAX, LAT_MIN, LAT_MAX

DAYS_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "days")
WEB_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "web")

SAMPLE_MINUTES = 7       # min spacing between kept points for MOVING vessels
                         # (year plays fully compressed; the 'A day' view is finer)
IDLE_MINUTES = 60        # spacing for near-stationary vessels (sog < IDLE_SOG)
IDLE_SOG = 1.0           # knots; below this a vessel is anchored/moored
GAP_MINUTES = 18         # break a trip into a new segment past this time gap
MAX_STEP_KM = 3.0        # break a trip if two kept points jump farther than this
                         # (kills bad AIS fixes + long chords that cross land)
MIN_SEG_POINTS = 2       # drop singleton segments
MIN_SEG_MOVE = 0.002     # ~200 m; drop segments that never really move
COORD_DP = 5             # ~1 m precision


def _km(a, b):
    """Approx great-circle distance (km) between [lon,lat] points a and b."""
    mlat = math.radians((a[1] + b[1]) / 2)
    dx = (b[0] - a[0]) * 111.320 * math.cos(mlat)
    dy = (b[1] - a[1]) * 110.574
    return math.hypot(dx, dy)

# Color per category (used by frontend + legend). Bright on dark basemap.
COLORS = {
    "passenger": [0, 200, 255],   # cyan  -- ferries/cruise
    "cargo":     [255, 170, 0],   # amber
    "tanker":    [255, 60, 90],   # red   -- hazmat-ish
    "tug":       [120, 255, 120], # green -- tugs/barges
    "pleasure":  [200, 120, 255], # purple
    "fishing":   [255, 255, 120], # yellow
    "other":     [150, 160, 175], # grey
}


def months_available():
    days = sorted(glob.glob(os.path.join(DAYS_DIR, "ais-*.parquet")))
    return sorted({os.path.basename(d)[4:11] for d in days})  # 'YYYY-MM'


def build_month(month):
    files = sorted(glob.glob(os.path.join(DAYS_DIR, f"ais-{month}-*.parquet")))
    if not files:
        return None
    df = pd.concat((pd.read_parquet(f) for f in files), ignore_index=True)
    df = df.sort_values(["mmsi", "t"])
    cat_idx = {c: i for i, c in enumerate(CATEGORIES)}
    sample = pd.Timedelta(minutes=SAMPLE_MINUTES)
    gap = pd.Timedelta(minutes=GAP_MINUTES)

    idle = pd.Timedelta(minutes=IDLE_MINUTES)
    trips = []
    n_pts = 0
    for mmsi, g in df.groupby("mmsi", sort=False):
        g = g.reset_index(drop=True)
        cat = cat_idx.get(str(g["category"].iloc[0]), len(CATEGORIES) - 1)
        path, ts = [], []
        last_t = None
        sog_vals = g.sog.fillna(0).values
        for lon, lat, t, sog in zip(g.longitude.values, g.latitude.values, g.t, sog_vals):
            if last_t is not None and (t - last_t) > gap:
                n_pts += _flush(trips, cat, path, ts)
                path, ts = [], []
                last_t = None
            spacing = idle if sog < IDLE_SOG else sample
            if last_t is None or (t - last_t) >= spacing:
                pt = [round(float(lon), COORD_DP), round(float(lat), COORD_DP)]
                if path and _km(path[-1], pt) > MAX_STEP_KM:
                    n_pts += _flush(trips, cat, path, ts)
                    path, ts = [], []
                path.append(pt)
                ts.append(int(t.timestamp()))
                last_t = t
        n_pts += _flush(trips, cat, path, ts)
    return trips, n_pts


def _bbox_span(path):
    xs = [p[0] for p in path]
    ys = [p[1] for p in path]
    return max(max(xs) - min(xs), max(ys) - min(ys))


def _flush(trips, cat, path, ts):
    if len(path) >= MIN_SEG_POINTS and _bbox_span(path) >= MIN_SEG_MOVE:
        trips.append({"c": cat, "p": path, "t": ts})
        return len(path)
    return 0


def main():
    os.makedirs(WEB_DIR, exist_ok=True)
    target = sys.argv[1:] or months_available()
    manifest_months = []
    total_trips = total_pts = 0
    t_min, t_max = None, None
    for month in target:
        res = build_month(month)
        if not res:
            print(f"{month}: no data")
            continue
        trips, n_pts = res
        out = os.path.join(WEB_DIR, f"trips-{month}.json")
        with open(out, "w") as f:
            json.dump(trips, f, separators=(",", ":"))
        size_mb = os.path.getsize(out) / 1e6
        # track time range
        for tr in trips:
            t_min = tr["t"][0] if t_min is None else min(t_min, tr["t"][0])
            t_max = tr["t"][-1] if t_max is None else max(t_max, tr["t"][-1])
        total_trips += len(trips)
        total_pts += n_pts
        manifest_months.append(month)
        print(f"{month}: {len(trips):,} segments, {n_pts:,} points, {size_mb:.1f} MB")

    manifest = {
        "months": manifest_months,
        "categories": CATEGORIES,
        "colors": COLORS,
        "bbox": [LON_MIN, LAT_MIN, LON_MAX, LAT_MAX],
        "sampleMinutes": SAMPLE_MINUTES,
        "tMin": t_min, "tMax": t_max,
        "totalSegments": total_trips, "totalPoints": total_pts,
    }
    with open(os.path.join(WEB_DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nTOTAL: {total_trips:,} segments, {total_pts:,} points across "
          f"{len(manifest_months)} month(s)")


if __name__ == "__main__":
    main()
