/* Harbor Motion — animated NYC harbor boat traffic on the working NOAA chart.
   Year replay: deck.gl TripsLayer over a real year of NOAA AIS tracks.
   Live: real-time positions relayed from AISStream via a Cloudflare Worker. */

// ---- Config -------------------------------------------------------------
const RELAY_URL = "wss://nyc-harbor-ais-relay.joshgreenman.workers.dev";
const DATA = "data/web/";

// NOAA ENC Maritime Chart Service (paper-chart symbology) as a WMS raster base.
const ENC_WMS = "https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/WMSServer";
const ENC_TILES = ENC_WMS +
  "?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true" +
  "&LAYERS=0,1,2,3,4,5,6,7,8,9,10,11,12&STYLES=&CRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}";

// Vivid vessel palette tuned to pop on buff land + blue water.
const PALETTE = {
  passenger: [255, 36, 112],   // rose  — ferries / cruise
  cargo:     [255, 122, 0],    // orange
  tanker:    [206, 22, 30],    // red
  tug:       [0, 168, 96],     // green — tugs & barges
  pleasure:  [124, 60, 232],   // violet
  fishing:   [240, 196, 0],    // gold
  other:     [64, 92, 116],    // slate
};
const CASING = [9, 24, 40];    // dark trail casing so colors read on light chart

// Mirror of pipeline/harbor.py category_for() for live AIS ship-type codes.
function categoryFor(t) {
  t = parseInt(t, 10);
  if (t >= 60 && t <= 69) return "passenger";
  if (t >= 70 && t <= 79) return "cargo";
  if (t >= 80 && t <= 89) return "tanker";
  if (t === 31 || t === 32 || t === 52) return "tug";
  if (t === 36 || t === 37) return "pleasure";
  if (t === 30) return "fishing";
  return "other";
}
const LABELS = {
  passenger: "Ferries / passenger", cargo: "Cargo", tanker: "Tankers",
  tug: "Tugs & barges", pleasure: "Sailing / pleasure", fishing: "Fishing", other: "Other",
};

// ---- State --------------------------------------------------------------
let manifest = null, allTrips = [];
const active = new Set();
let mode = "year", playing = true, currentTime = 0, daysPerSec = 3, lastFrame = 0;
let ws = null;
const live = new Map();

const $ = (id) => document.getElementById(id);
const statusEl = $("status"), statusText = $("status-text");
const showStatus = (t) => { statusText.innerHTML = t; statusEl.classList.add("show"); };
const hideStatus = () => statusEl.classList.remove("show");
const colorFor = (cat) => PALETTE[cat] || PALETTE.other;

// ---- Map ----------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      enc: { type: "raster", tiles: [ENC_TILES], tileSize: 256, attribution: "Chart: NOAA ENC®" },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#e8dab9" } },
      { id: "enc", type: "raster", source: "enc", paint: { "raster-opacity": 1 } },
    ],
  },
  center: [-73.97, 40.655], zoom: 10,   // whole city; NOAA ENC renders from ~z10 up
  attributionControl: false, minZoom: 9.9, maxZoom: 15, dragRotate: false,
});
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-left");

const overlay = new deck.MapboxOverlay({ interleaved: true, layers: [] });
map.addControl(overlay);

const tooltip = $("tooltip");
function setTooltip(x, y, html) {
  if (!html) { tooltip.style.display = "none"; return; }
  tooltip.innerHTML = html; tooltip.style.display = "block";
  tooltip.style.left = (x + 14) + "px"; tooltip.style.top = (y + 14) + "px";
}

// ---- Graticule (faint lat/lon grid, a chart touch) ----------------------
function addGraticule() {
  const lines = [];
  for (let lon = -74.3; lon <= -73.6; lon += 0.05)
    lines.push([[lon, 40.45], [lon, 40.95]]);
  for (let lat = 40.45; lat <= 40.95; lat += 0.05)
    lines.push([[-74.35, lat], [-73.6, lat]]);
  map.addSource("grat", { type: "geojson",
    data: { type: "Feature", geometry: { type: "MultiLineString", coordinates: lines } } });
  map.addLayer({ id: "grat", type: "line", source: "grat",
    paint: { "line-color": "#14304a", "line-opacity": 0.1, "line-width": 0.5, "line-dasharray": [3, 4] } });
}

// ---- Data load ----------------------------------------------------------
async function loadData() {
  showStatus('<span class="spin"></span>Charting the harbor…');
  manifest = await (await fetch(DATA + "manifest.json")).json();
  manifest.categories.forEach((c) => active.add(c));
  buildLegend();
  for (let i = 0; i < manifest.months.length; i++) {
    const m = manifest.months[i];
    showStatus(`<span class="spin"></span>Plotting ${m} (${i + 1}/${manifest.months.length})…`);
    try {
      const trips = await (await fetch(`${DATA}trips-${m}.json`)).json();
      for (const tr of trips) allTrips.push(tr);
    } catch (e) { console.warn("month load failed", m, e); }
  }
  currentTime = manifest.tMin; $("timeline").value = 0;
  hideStatus(); lastFrame = performance.now(); requestAnimationFrame(tick);
}

// ---- Legend / filters ---------------------------------------------------
function buildLegend() {
  const el = $("legend"); el.innerHTML = "";
  manifest.categories.forEach((c) => {
    const col = colorFor(c);
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<span class="dot" style="background:rgb(${col});color:rgb(${col})"></span>${LABELS[c] || c}`;
    chip.onclick = () => {
      if (active.has(c)) { active.delete(c); chip.classList.add("off"); }
      else { active.add(c); chip.classList.remove("off"); }
    };
    el.appendChild(chip);
  });
}

// ---- Year replay layers (casing + colored trails) -----------------------
function yearLayers() {
  const cats = manifest.categories;
  const secPerSec = daysPerSec * 86400;
  const trail = secPerSec * 1.4;
  const data = allTrips.filter((d) => active.has(cats[d.c]));
  const common = {
    data, getPath: (d) => d.p, getTimestamps: (d) => d.t,
    trailLength: trail, currentTime, fadeTrail: true,
    jointRounded: true, capRounded: true, parameters: { depthTest: false },
  };
  return [
    new deck.TripsLayer({ ...common, id: "trips-casing",
      getColor: CASING, opacity: 0.5, widthMinPixels: 4.4 }),
    new deck.TripsLayer({ ...common, id: "trips",
      getColor: (d) => colorFor(cats[d.c]), opacity: 0.95, widthMinPixels: 2.4 }),
  ];
}

// ---- Live layers --------------------------------------------------------
function liveLayers() {
  const now = Date.now() / 1000;
  const dots = [...live.values()].filter((v) => active.has(v.cat) && v.lon != null);
  const trails = dots.filter((v) => v.trail.length > 1)
    .map((v) => ({ cat: v.cat, p: v.trail.map((q) => [q[0], q[1]]), t: v.trail.map((q) => q[2]) }));
  return [
    new deck.TripsLayer({ id: "live-trails", data: trails,
      getPath: (d) => d.p, getTimestamps: (d) => d.t,
      getColor: (d) => colorFor(d.cat), opacity: 0.75, widthMinPixels: 2,
      trailLength: 1200, currentTime: now, fadeTrail: true, capRounded: true,
      parameters: { depthTest: false } }),
    new deck.ScatterplotLayer({ id: "live-dots", data: dots,
      getPosition: (d) => [d.lon, d.lat],
      getFillColor: (d) => colorFor(d.cat),
      getLineColor: CASING, lineWidthMinPixels: 1.2, stroked: true,
      getRadius: (d) => (d.cat === "cargo" || d.cat === "tanker" ? 120 : 75),
      radiusMinPixels: 3.5, radiusMaxPixels: 13, pickable: true,
      parameters: { depthTest: false },
      updateTriggers: { getFillColor: [...active].join() } }),
  ];
}

// ---- Render loop --------------------------------------------------------
function tick(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1); lastFrame = now;
  if (mode === "year") {
    if (playing && manifest) {
      currentTime += daysPerSec * 86400 * dt;
      if (currentTime > manifest.tMax) currentTime = manifest.tMin;
      $("timeline").value = Math.round(
        (currentTime - manifest.tMin) / (manifest.tMax - manifest.tMin) * 1000);
      updateClock();
    }
    overlay.setProps({ layers: yearLayers() });
  } else {
    overlay.setProps({ layers: liveLayers() });
  }
  requestAnimationFrame(tick);
}

const SEASONS = ["Winter", "Winter", "Spring", "Spring", "Spring", "Summer",
  "Summer", "Summer", "Autumn", "Autumn", "Autumn", "Winter"];
function updateClock() {
  const d = new Date(currentTime * 1000);
  $("date").textContent = d.toLocaleDateString("en-US",
    { month: "short", day: "numeric", timeZone: "America/New_York" });
  $("season").textContent = SEASONS[d.getMonth()] + " " + d.getFullYear();
}

// ---- Controls -----------------------------------------------------------
$("play").onclick = () => { playing = !playing; $("play").textContent = playing ? "❚❚" : "▶"; };
$("speed").onchange = (e) => { daysPerSec = +e.target.value; };
$("timeline").oninput = (e) => {
  if (mode !== "year" || !manifest) return;
  currentTime = manifest.tMin + (e.target.value / 1000) * (manifest.tMax - manifest.tMin);
  updateClock();
};

// ---- Mode switching -----------------------------------------------------
$("mode-year").onclick = () => setMode("year");
$("mode-live").onclick = () => setMode("live");
function setMode(m) {
  if (m === mode) return;
  mode = m;
  $("mode-year").classList.toggle("active", m === "year");
  $("mode-live").classList.toggle("active", m === "live");
  const yearOnly = document.querySelectorAll("#play, #timeline, #speed, #season, #date");
  if (m === "live") {
    yearOnly.forEach((el) => (el.style.display = "none"));
    $("live-count").style.display = "inline"; connectLive();
  } else {
    yearOnly.forEach((el) => (el.style.display = ""));
    $("live-count").style.display = "none";
    if (ws) { ws.close(); ws = null; }
  }
}

// ---- Live websocket -----------------------------------------------------
function connectLive() {
  $("live-count").textContent = "connecting…";
  try { ws = new WebSocket(RELAY_URL); }
  catch (e) { $("live-count").textContent = "live unavailable"; return; }
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const t = Date.now() / 1000;
    let v = live.get(msg.mmsi);
    if (!v) { v = { cat: "other", name: "", trail: [] }; live.set(msg.mmsi, v); }
    if (msg.type === "pos") {
      v.lon = msg.lon; v.lat = msg.lat; v.hdg = msg.hdg; v.sog = msg.sog;
      if (msg.name) v.name = msg.name;
      v.trail.push([msg.lon, msg.lat, t]);
      if (v.trail.length > 60) v.trail.shift();
      v.last = t;
    } else if (msg.type === "static") {
      if (msg.name) v.name = msg.name;
      v.cat = categoryFor(msg.shipType);
    }
  };
  ws.onclose = () => { if (mode === "live") $("live-count").textContent = "disconnected"; };
  ws.onerror = () => { $("live-count").textContent = "live unavailable"; };
  setInterval(() => {
    if (mode !== "live") return;
    const cut = Date.now() / 1000 - 600;
    for (const [k, v] of live) if ((v.last || 0) < cut) live.delete(k);
    $("live-count").textContent = `${live.size} vessels on the water`;
  }, 2000);
}

// ---- Hover tooltip ------------------------------------------------------
overlay.setProps({
  onHover: (info) => {
    if (mode === "live" && info.object && info.layer && info.layer.id === "live-dots") {
      const v = info.object;
      const spd = v.sog != null ? `${v.sog.toFixed(1)} kn` : "";
      setTooltip(info.x, info.y,
        `<div class="nm">${v.name || "Unknown vessel"}</div>
         <div class="meta">${LABELS[v.cat] || v.cat}${spd ? " · " + spd : ""}</div>`);
    } else setTooltip(0, 0, null);
  },
});

// ---- Compass rose ticks -------------------------------------------------
(function compassTicks() {
  const g = document.getElementById("ticks"); if (!g) return;
  const NS = "http://www.w3.org/2000/svg";
  for (let deg = 0; deg < 360; deg += 5) {
    const major = deg % 30 === 0, len = major ? 10 : 5, r = 92;
    const rad = deg * Math.PI / 180;
    const x1 = 100 + r * Math.sin(rad), y1 = 100 - r * Math.cos(rad);
    const x2 = 100 + (r - len) * Math.sin(rad), y2 = 100 - (r - len) * Math.cos(rad);
    const ln = document.createElementNS(NS, "line");
    ln.setAttribute("x1", x1); ln.setAttribute("y1", y1);
    ln.setAttribute("x2", x2); ln.setAttribute("y2", y2);
    ln.setAttribute("stroke-width", major ? 1.4 : 0.7);
    g.appendChild(ln);
  }
})();

// ---- Go -----------------------------------------------------------------
// Add the graticule once the chart style is ready (non-critical if it fails),
// but start loading vessel data immediately -- don't wait on slow WMS tiles.
map.on("load", () => {
  try { addGraticule(); } catch (e) { console.warn("graticule", e); }
  map.resize();
});
loadData();
