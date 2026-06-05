"""Shared constants for the NYC Harbor Traffic pipeline.

Bounding box and vessel-type mapping are used identically by the historical
filter (NOAA Marine Cadastre) and the live subscription (AISStream).
"""

# Harbor bounding box around Manhattan.
# Covers Upper & Lower Bay, the Narrows, Hudson River, East River, Harlem
# River, Kill Van Kull, Arthur Kill, Newark Bay and the Rockaway approach.
LON_MIN, LON_MAX = -74.28, -73.70
LAT_MIN, LAT_MAX = 40.45, 40.92

# Columns we keep from the NOAA daily CSV (2025 lowercase schema).
KEEP_COLS = [
    "mmsi", "base_date_time", "longitude", "latitude",
    "sog", "cog", "heading", "vessel_name", "vessel_type",
]

# AIS vessel-type code -> our display category.
# Codes follow ITU/AIS Ship Type ranges. We collapse into 7 categories.
CATEGORIES = [
    "passenger", "cargo", "tanker", "tug", "pleasure", "fishing", "other",
]


def category_for(vessel_type):
    """Map a numeric AIS vessel_type code to one of CATEGORIES."""
    try:
        t = int(float(vessel_type))
    except (TypeError, ValueError):
        return "other"
    if 60 <= t <= 69:
        return "passenger"          # ferries, cruise
    if 70 <= t <= 79:
        return "cargo"
    if 80 <= t <= 89:
        return "tanker"
    if t in (31, 32, 52):
        return "tug"                # towing / tug
    if t in (36, 37):
        return "pleasure"           # sailing / pleasure craft
    if t == 30:
        return "fishing"
    return "other"                   # pilot (50), law/SAR, undefined, etc.


def category_code(vessel_type):
    """Integer index into CATEGORIES (for compact binary packing)."""
    return CATEGORIES.index(category_for(vessel_type))


NOAA_URL = "https://coast.noaa.gov/htdata/CMSP/AISDataHandler/{year}/ais-{date}.csv.zst"


def noaa_url(date_str):
    """date_str like '2025-06-01' -> full download URL."""
    return NOAA_URL.format(year=date_str[:4], date=date_str)
