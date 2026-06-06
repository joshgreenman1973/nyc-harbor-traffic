"""Compute 'by the numbers' stats for Harbor Motion's data strip:
month-by-month seasonality, fleet composition, where vessels enter the harbor
(origins by gateway), the busiest day, and a few computed seasonal facts.

Output: data/web/stats.json
"""
import os, sys, glob, json
from collections import defaultdict
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from harbor import CATEGORIES, LON_MIN, LON_MAX, LAT_MIN, LAT_MAX

DAYS = os.path.join(os.path.dirname(__file__), "..", "data", "days")
WEB = os.path.join(os.path.dirname(__file__), "..", "data", "web")
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def gateway(lat, lon):
    m = 0.02
    if lat <= LAT_MIN + m: return "Atlantic / Lower Bay"     # south edge -> the ocean
    if lon <= LON_MIN + m: return "Arthur Kill / NJ"          # west edge
    if lat >= LAT_MAX - m: return "Up the Hudson"             # north edge
    if lon >= LON_MAX - m: return "Long Island Sound"         # east edge
    return "Harbor berths"                                     # started/ended inside


month_cat = {m: defaultdict(set) for m in range(1, 13)}   # month -> cat -> set(mmsi)
month_all = {m: set() for m in range(1, 13)}
all_cat = defaultdict(set)
day_counts = {}                                            # date -> unique vessels
origins = defaultdict(int)                                 # gateway -> vessel-days

files = sorted(glob.glob(os.path.join(DAYS, "ais-*.parquet")))
for n, f in enumerate(files, 1):
    date = os.path.basename(f)[4:14]
    mo = int(date[5:7])
    df = pd.read_parquet(f, columns=["mmsi", "category", "longitude", "latitude", "t"])
    day_counts[date] = int(df.mmsi.nunique())
    for cat, g in df.groupby("category", observed=True):
        c = str(cat); c = c if c in CATEGORIES else "other"
        u = set(g.mmsi.unique())
        month_cat[mo][c] |= u; month_all[mo] |= u; all_cat[c] |= u
    # origin = gateway of each vessel's FIRST position that day
    df = df.sort_values("t")
    first = df.groupby("mmsi", observed=True).first()
    for lat, lon in zip(first.latitude.values, first.longitude.values):
        origins[gateway(lat, lon)] += 1
    if n % 60 == 0:
        print(f"  {n}/{len(files)} days")

by_month = [{"m": MONTHS[mo - 1], "vessels": len(month_all[mo]),
             "byCat": {c: len(month_cat[mo][c]) for c in CATEGORIES}} for mo in range(1, 13)]
by_cat = [{"cat": c, "vessels": len(all_cat[c])} for c in CATEGORIES]
busiest = max(day_counts.items(), key=lambda kv: kv[1])

# --- computed seasonal facts ---
def season_sum(cat, mos):
    return len(set().union(*[month_cat[mo][cat] for mo in mos]))
summer = season_sum("pleasure", [6, 7, 8]); winter = season_sum("pleasure", [12, 1, 2])
ratio = round(summer / winter, 1) if winter else None
busiest_month = max(range(1, 13), key=lambda mo: len(month_all[mo]))
tug_summer = season_sum("tug", [6, 7, 8]); tug_winter = season_sum("tug", [12, 1, 2])
top_gateway = max((k for k in origins if k != "Harbor berths"), key=lambda k: origins[k])

facts = [
    f"Recreational boating is overwhelmingly seasonal: about {ratio}× as many sailing & "
    f"pleasure craft appear in summer (Jun–Aug) as in winter (Dec–Feb)."
    if ratio else "",
    f"The harbor is busiest in {MONTHS[busiest_month-1]}, with {len(month_all[busiest_month]):,} distinct vessels.",
    f"Working boats run year-round: roughly {tug_summer:,} tug & barge vessels in summer vs "
    f"{tug_winter:,} in winter — barely a seasonal dip.",
    f"Of vessels that enter from outside the harbor, the most common gateway is {top_gateway}.",
    f"The single busiest day of {busiest[0][:4]} was {busiest[0]}, with {busiest[1]:,} vessels on the water.",
]
facts = [f for f in facts if f]

out = {
    "year": 2025,
    "totalVessels": len(set().union(*all_cat.values())),
    "byCategory": by_cat,
    "byMonth": by_month,
    "origins": [{"gateway": k, "vesselDays": v} for k, v in sorted(origins.items(), key=lambda kv: -kv[1])],
    "busiest": {"date": busiest[0], "vessels": busiest[1]},
    "facts": facts,
}
os.makedirs(WEB, exist_ok=True)
json.dump(out, open(os.path.join(WEB, "stats.json"), "w"), separators=(",", ":"))
print("byMonth:", [(m["m"], m["vessels"]) for m in by_month])
print("origins:", out["origins"])
print("facts:"); [print("  -", f) for f in facts]
print(f"-> stats.json")
