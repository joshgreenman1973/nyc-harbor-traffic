"""Compute per-category vessel + transit counts for the year and patch them into
manifest.json (so the year filters can show real numbers). Fast: reads only the
mmsi/category/t columns from the day parquets, no trip rebuild.

transits = vessel-days (distinct vessel per calendar day, summed) — a proxy for
the number of journeys; vessels = distinct MMSI over the year.
"""
import os, sys, glob, json
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from harbor import CATEGORIES

DAYS = os.path.join(os.path.dirname(__file__), "..", "data", "days")
WEB = os.path.join(os.path.dirname(__file__), "..", "data", "web")

vessels = {c: set() for c in CATEGORIES}
transits = {c: 0 for c in CATEGORIES}

files = sorted(glob.glob(os.path.join(DAYS, "ais-*.parquet")))
for f in files:
    df = pd.read_parquet(f, columns=["mmsi", "category"])
    for cat, g in df.groupby("category", observed=True):
        c = str(cat)
        if c not in vessels:
            c = "other"
        uniq = set(g["mmsi"].unique())
        vessels[c].update(uniq)
        transits[c] += len(uniq)   # distinct vessels that day = ~journeys

counts = {c: {"vessels": len(vessels[c]), "transits": transits[c]} for c in CATEGORIES}
counts["_total"] = {
    "vessels": len(set().union(*vessels.values())) if files else 0,
    "transits": sum(transits.values()),
}

mpath = os.path.join(WEB, "manifest.json")
manifest = json.load(open(mpath))
manifest["counts"] = counts
json.dump(manifest, open(mpath, "w"), indent=2)
for c in CATEGORIES:
    print(f"{c:12s} {counts[c]['vessels']:6,} vessels  {counts[c]['transits']:8,} transits")
print(f"{'TOTAL':12s} {counts['_total']['vessels']:6,} vessels  {counts['_total']['transits']:8,} transits")
