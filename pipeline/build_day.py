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
from zoneinfo import ZoneInfo

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from harbor import CATEGORIES

DAYS_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "days")
WEB_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "web")

SAMPLE_MINUTES = 2       # fine: smooth motion for a single day
MOVE_SOG = 1.5           # knots; below this a vessel is parked/jittering -> not drawn
THROUGH_KM = 1.5         # but always keep a vessel that crossed the box this far,
                         # even if it never read as 'underway' (through-traffic)
GAP_MINUTES = 15
MAX_STEP_KM = 3.0
MIN_SEG_POINTS = 2
MIN_SEG_MOVE = 0.003     # ~330 m; a real journey moves, GPS jitter doesn't
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


def most_recent_complete():
    """Latest date D whose full Eastern day is covered (D and D+1 both present)."""
    import glob as _g
    days = sorted(os.path.basename(p)[4:14] for p in _g.glob(os.path.join(DAYS_DIR, "ais-*.parquet")))
    have = set(days)
    for d in reversed(days):
        nd = (pd.Timestamp(d) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
        if nd in have:
            return d
    return days[-1] if days else None


def main():
    date = sys.argv[1] if len(sys.argv) > 1 else most_recent_complete()
    print(f"day: {date}")
    # NOAA files are UTC calendar days; we want a local (Eastern) calendar day.
    # Use real America/New_York offset so EST (winter) vs EDT (summer) is correct.
    ny = ZoneInfo("America/New_York")
    start = pd.Timestamp(date + " 00:00", tz=ny).tz_convert("UTC").tz_localize(None)
    end = (pd.Timestamp(date + " 00:00", tz=ny) + pd.Timedelta(days=1)).tz_convert("UTC").tz_localize(None)
    next_date = (pd.Timestamp(date) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
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
    gap = pd.Timedelta(minutes=GAP_MINUTES)

    trips, n_pts = [], 0
    moved = {c: set() for c in CATEGORIES}   # vessels that actually got underway
    for mmsi, g in df.groupby("mmsi", sort=False):
        g = g.reset_index(drop=True)
        cstr = str(g["category"].iloc[0])
        cat = cat_idx.get(cstr, len(CATEGORIES) - 1)
        path, ts, last_t = [], [], None
        before = len(trips)
        for lon, lat, t, sog in zip(g.longitude.values, g.latitude.values, g.t, g.sog.fillna(0).values):
            if sog < MOVE_SOG:   # parked / jittering -> end the current journey, don't draw
                n_pts += _flush(trips, cat, path, ts); path, ts, last_t = [], [], None
                continue
            if last_t is not None and (t - last_t) > gap:
                n_pts += _flush(trips, cat, path, ts); path, ts, last_t = [], [], None
            if last_t is None or (t - last_t) >= sample:
                pt = [round(float(lon), COORD_DP), round(float(lat), COORD_DP)]
                if path and _km(path[-1], pt) > MAX_STEP_KM:
                    n_pts += _flush(trips, cat, path, ts); path, ts = [], []
                path.append(pt); ts.append(int(t.timestamp())); last_t = t
        n_pts += _flush(trips, cat, path, ts)
        # Safety net: a vessel that crossed the box but never registered as
        # 'underway' (e.g. a slow drift-through) — include its track anyway so
        # through-traffic that doesn't originate or dock here is never lost.
        if len(trips) == before:
            la = g.latitude.values; lo = g.longitude.values
            if len(lo) >= 2 and _km([lo[0], la[0]], [lo[-1], la[-1]]) > THROUGH_KM:
                path, ts, last_t = [], [], None
                for lon, lat, t in zip(lo, la, g.t):
                    if last_t is not None and (t - last_t) > gap:
                        n_pts += _flush(trips, cat, path, ts); path, ts, last_t = [], [], None
                    if last_t is None or (t - last_t) >= sample:
                        pt = [round(float(lon), COORD_DP), round(float(lat), COORD_DP)]
                        if path and _km(path[-1], pt) > MAX_STEP_KM:
                            n_pts += _flush(trips, cat, path, ts); path, ts = [], []
                        path.append(pt); ts.append(int(t.timestamp())); last_t = t
                n_pts += _flush(trips, cat, path, ts)
        if len(trips) > before:
            moved[cstr if cstr in moved else "other"].add(mmsi)

    # counts = vessels that actually made a journey (matches what's drawn)
    counts = {c: {"vessels": len(moved[c])} for c in CATEGORIES}
    counts["_total"] = {"vessels": sum(len(moved[c]) for c in CATEGORIES)}

    t_all = [tt for tr in trips for tt in tr["t"]]
    out = {"date": date, "tMin": min(t_all), "tMax": max(t_all), "counts": counts, "trips": trips}
    os.makedirs(WEB_DIR, exist_ok=True)
    with open(os.path.join(WEB_DIR, "day.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))
    size = os.path.getsize(os.path.join(WEB_DIR, "day.json")) / 1e6
    print(f"{date}: {len(trips):,} segments, {n_pts:,} points, "
          f"{df.mmsi.nunique():,} vessels, {size:.1f} MB")


if __name__ == "__main__":
    main()
