"""Build an MMSI -> [categoryIndex, name] lookup from the 2025 archive.

AIS static data (type, name) only broadcasts every ~6 minutes, so live vessels
arrive uncategorized at first. This lookup lets the live view colour and label
the harbor's regulars instantly from what we already know about them.

Output: data/web/vessels.json  { "<mmsi>": [catIdx, "NAME"], ... }
"""
import os, sys, glob, json
from collections import defaultdict, Counter
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from harbor import CATEGORIES

DAYS = os.path.join(os.path.dirname(__file__), "..", "data", "days")
WEB = os.path.join(os.path.dirname(__file__), "..", "data", "web")
CIDX = {c: i for i, c in enumerate(CATEGORIES)}

cats = defaultdict(Counter)
names = {}
files = sorted(glob.glob(os.path.join(DAYS, "ais-*.parquet")))
for n, f in enumerate(files, 1):
    d = pd.read_parquet(f, columns=["mmsi", "category", "vessel_name"])
    g = d.groupby(["mmsi", "category"], observed=True).size()
    for (m, c), cnt in g.items():
        cats[int(m)][str(c)] += int(cnt)
    nm = d.dropna(subset=["vessel_name"]).drop_duplicates("mmsi")
    for m, name in zip(nm.mmsi.values, nm.vessel_name.values):
        m = int(m)
        if m not in names:
            s = str(name).strip()
            if s:
                names[m] = s
    if n % 60 == 0:
        print(f"  {n}/{len(files)} days, {len(cats):,} vessels")

out = {}
for m, cc in cats.items():
    cat = cc.most_common(1)[0][0]
    out[str(m)] = [CIDX.get(cat, len(CATEGORIES) - 1), names.get(m, "")]
os.makedirs(WEB, exist_ok=True)
path = os.path.join(WEB, "vessels.json")
json.dump(out, open(path, "w"), separators=(",", ":"))
print(f"{len(out):,} vessels -> vessels.json ({os.path.getsize(path)/1e6:.1f} MB)")
