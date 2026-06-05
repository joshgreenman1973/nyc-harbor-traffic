"""Build a high-detail single-day file for the 'A day in the harbor' view.

Finer sampling than the year bundle (the day view shows individual crossings,
not accumulated density), so motion is smooth and legible.

Output: data/web/day.json = {date, tMin, tMax, trips:[{c,p,t}, ...]}

Usage:
    python pipeline/build_day.py 2025-07-04
"""
import os
import sys
import json
import math

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from harbor import CATEGORIES

DAYS_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "days")
WEB_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "web")

SAMPLE_MINUTES = 2       # fine: smooth motion for a single day
IDLE_MINUTES = 30
IDLE_SOG = 1.0
GAP_MINUTES = 15
MAX_STEP_KM = 3.0
MIN_SEG_POINTS = 2
MIN_SEG_MOVE = 0.0015
COORD_DP = 5


def _km(a, b):
    mlat = math.radians((a[1] + b[1]) / 2)
    dx = (b[0] - a[0]) * 111.320 * math.cos(mlat)
    dy = (b[1] - a[1]) * 110.574
    return math.hypot(dx, dy)


def _span(path):
    xs = [p[0] for p in path]; ys = [p[1] for p in path]
    return max(max(xs) - min(xs), max(ys) - min(ys))


def _flush(trips, cat, path, ts):
    if len(path) >= MIN_SEG_POINTS and _span(path) >= MIN_SEG_MOVE:
        trips.append({"c": cat, "p": path, "t": ts})
        return len(path)
    return 0


def main():
    date = sys.argv[1] if len(sys.argv) > 1 else "2025-07-04"
    # NOAA files are UTC calendar days; we want a local (Eastern) calendar day,
    # which in July is UTC-4. So an EDT day D = UTC [D 04:00, D+1 04:00).
    d0 = pd.Timestamp(date)
    start = d0 + pd.Timedelta(hours=4)
    end = d0 + pd.Timedelta(days=1, hours=4)
    next_date = (d0 + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    parts = []
    for dd in (date, next_date):
        p = os.path.join(DAYS_DIR, f"ais-{dd}.parquet")
        if os.path.exists(p):
            parts.append(pd.read_parquet(p))
    if not parts:
        print(f"missing parquet for {date}"); sys.exit(1)
    df = pd.concat(parts, ignore_index=True)
    df = df[(df["t"] >= start) & (df["t"] < end)].sort_values(["mmsi", "t"])
    cat_idx = {c: i for i, c in enumerate(CATEGORIES)}
    sample = pd.Timedelta(minutes=SAMPLE_MINUTES)
    idle = pd.Timedelta(minutes=IDLE_MINUTES)
    gap = pd.Timedelta(minutes=GAP_MINUTES)

    trips, n_pts = [], 0
    for mmsi, g in df.groupby("mmsi", sort=False):
        g = g.reset_index(drop=True)
        cat = cat_idx.get(str(g["category"].iloc[0]), len(CATEGORIES) - 1)
        path, ts, last_t = [], [], None
        for lon, lat, t, sog in zip(g.longitude.values, g.latitude.values, g.t, g.sog.fillna(0).values):
            if last_t is not None and (t - last_t) > gap:
                n_pts += _flush(trips, cat, path, ts); path, ts, last_t = [], [], None
            spacing = idle if sog < IDLE_SOG else sample
            if last_t is None or (t - last_t) >= spacing:
                pt = [round(float(lon), COORD_DP), round(float(lat), COORD_DP)]
                if path and _km(path[-1], pt) > MAX_STEP_KM:
                    n_pts += _flush(trips, cat, path, ts); path, ts = [], []
                path.append(pt); ts.append(int(t.timestamp())); last_t = t
        n_pts += _flush(trips, cat, path, ts)

    t_all = [tt for tr in trips for tt in tr["t"]]
    out = {"date": date, "tMin": min(t_all), "tMax": max(t_all), "trips": trips}
    os.makedirs(WEB_DIR, exist_ok=True)
    with open(os.path.join(WEB_DIR, "day.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))
    size = os.path.getsize(os.path.join(WEB_DIR, "day.json")) / 1e6
    print(f"{date}: {len(trips):,} segments, {n_pts:,} points, "
          f"{df.mmsi.nunique():,} vessels, {size:.1f} MB")


if __name__ == "__main__":
    main()
