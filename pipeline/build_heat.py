"""Aggregate the whole year's AIS positions into a density grid, per vessel
category, for the year heatmap. Replaces the huge per-track line bundle with a
small grid of where traffic actually concentrates.

Output: data/web/heat.json
  { res, lon0, lat0, cats:[...], cells: [[ix, iy, w0, w1, ...w6], ...] }
where w_i is the number of position pings in that cell for category i.
"""
import os, sys, glob, json
from collections import defaultdict
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from harbor import CATEGORIES, LON_MIN, LAT_MIN

DAYS = os.path.join(os.path.dirname(__file__), "..", "data", "days")
WEB = os.path.join(os.path.dirname(__file__), "..", "data", "web")

RES = 0.0012        # ~100 m cells
MIN_CELL = 3        # drop near-empty cells (noise) and shrink the file
CIDX = {c: i for i, c in enumerate(CATEGORIES)}

acc = defaultdict(lambda: [0] * len(CATEGORIES))
files = sorted(glob.glob(os.path.join(DAYS, "ais-*.parquet")))
for n, f in enumerate(files, 1):
    df = pd.read_parquet(f, columns=["longitude", "latitude", "category"])
    ix = ((df.longitude - LON_MIN) / RES).astype("int32")
    iy = ((df.latitude - LAT_MIN) / RES).astype("int32")
    cat = df.category.astype(str)
    g = pd.DataFrame({"ix": ix, "iy": iy, "cat": cat}).groupby(["ix", "iy", "cat"]).size()
    for (xi, yi, c), cnt in g.items():
        acc[(int(xi), int(yi))][CIDX.get(c, len(CATEGORIES) - 1)] += int(cnt)
    if n % 50 == 0:
        print(f"  {n}/{len(files)} days, {len(acc):,} cells so far")

cells = []
for (xi, yi), w in acc.items():
    if sum(w) >= MIN_CELL:
        cells.append([xi, yi] + w)

out = {"res": RES, "lon0": LON_MIN, "lat0": LAT_MIN, "cats": CATEGORIES, "cells": cells}
os.makedirs(WEB, exist_ok=True)
path = os.path.join(WEB, "heat.json")
json.dump(out, open(path, "w"), separators=(",", ":"))
size = os.path.getsize(path) / 1e6
print(f"{len(cells):,} cells -> heat.json ({size:.1f} MB)")
