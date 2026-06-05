/* Harbor Motion — NYC harbor boat traffic, drawn like colored pencil on the
   working NOAA nautical chart.
   Year  — a real year of AIS tracks (density of movement, by vessel type).
   A day — one real day (Jul 4, 2025) of actual crossings, animated over 24h.
   Live  — true real-time positions via AISStream, relayed by a Cloudflare Worker. */

// ---- Config -------------------------------------------------------------
const RELAY_URL = "wss://nyc-harbor-ais-relay.joshgreenman.workers.dev";
const DATA = "data/web/";

// NOAA ENC Maritime Chart Service (paper-chart symbology) as a WMS raster base.
const ENC_WMS = "https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/WMSServer";
const ENC_TILES = ENC_WMS +
  "?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true" +
  "&LAYERS=0,1,2,3,4,5,6,7,8,9,10,11,12&STYLES=&CRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}";

// Colored-pencil pigments — waxy, slightly muted, distinct on buff + blue.
const PALETTE = {
  passenger: [198, 58, 92],    // crimson
  cargo:     [203, 116, 50],   // burnt orange
  tanker:    [168, 52, 52],    // indian red
  tug:       [58, 120, 78],    // sap green
  pleasure:  [122, 90, 170],   // violet
  fishing:   [196, 156, 54],   // ochre
  other:     [92, 107, 122],   // payne's grey
};
const LABELS = {
  passenger: "Ferries / passenger", cargo: "Cargo", tanker: "Tankers",
  tug: "Tugs & barges", pleasure: "Sailing / pleasure", fishing: "Fishing", other: "Other",
};

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

// ---- State --------------------------------------------------------------
let manifest = null, allTrips = [];
let dayData = null, dayLoading = false;
const active = new Set();
let mode = "year", playing = true, currentTime = 0, daysPerSec = 3, lastFrame = 0;
const DAY_LOOP_SEC = 60;           // seconds to play one full day
let ws = null;
const live = new Map();
const CATS = () => manifest.categories;

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
    sources: { enc: { type: "raster", tiles: [ENC_TILES], tileSize: 256, attribution: "Chart: NOAA ENC®" } },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#e8dab9" } },
      { id: "enc", type: "raster", source: "enc", paint: { "raster-opacity": 1 } },
    ],
  },
  center: [-73.97, 40.655], zoom: 10,
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

function addGraticule() {
  const lines = [];
  for (let lon = -74.3; lon <= -73.6; lon += 0.05) lines.push([[lon, 40.45], [lon, 40.95]]);
  for (let lat = 40.45; lat <= 40.95; lat += 0.05) lines.push([[-74.35, lat], [-73.6, lat]]);
  map.addSource("grat", { type: "geojson",
    data: { type: "Feature", geometry: { type: "MultiLineString", coordinates: lines } } });
  map.addLayer({ id: "grat", type: "line", source: "grat",
    paint: { "line-color": "#14304a", "line-opacity": 0.08, "line-width": 0.5, "line-dasharray": [3, 4] } });
}

// ---- Data ---------------------------------------------------------------
async function loadData() {
  showStatus('<span class="spin"></span>Charting the harbor…');
  manifest = await (await fetch(DATA + "manifest.json")).json();
  manifest.categories.forEach((c) => active.add(c));
  buildLegend();
  for (let i = 0; i < manifest.months.length; i++) {
    const m = manifest.months[i];
    showStatus(`<span class="spin"></span>Plotting ${m} (${i + 1}/${manifest.months.length})…`);
    try { for (const tr of await (await fetch(`${DATA}trips-${m}.json`)).json()) allTrips.push(tr); }
    catch (e) { console.warn("month load failed", m, e); }
  }
  currentTime = manifest.tMin; $("timeline").value = 0;
  hideStatus(); lastFrame = performance.now(); requestAnimationFrame(tick);
}

async function ensureDay() {
  if (dayData || dayLoading) return;
  dayLoading = true;
  showStatus('<span class="spin"></span>Loading the day…');
  try { dayData = await (await fetch(DATA + "day.json")).json(); }
  catch (e) { console.warn("day load failed", e); }
  hideStatus(); dayLoading = false;
  if (mode === "day" && dayData) currentTime = dayData.tMin;
}

// ---- Legend / filters ---------------------------------------------------
function buildLegend() {
  const el = $("legend"); el.innerHTML = "";
  manifest.categories.forEach((c) => {
    const col = colorFor(c);
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<span class="dot" style="background:rgb(${col})"></span>${LABELS[c] || c}`;
    chip.onclick = () => {
      if (active.has(c)) { active.delete(c); chip.classList.add("off"); }
      else { active.add(c); chip.classList.remove("off"); }
    };
    el.appendChild(chip);
  });
}

// ---- Layers -------------------------------------------------------------
function pencilTrips(id, data, trail, t, width, op) {
  return new deck.TripsLayer({
    id, data, getPath: (d) => d.p, getTimestamps: (d) => d.t,
    getColor: (d) => colorFor(CATS()[d.c]),
    opacity: op, widthMinPixels: width, jointRounded: true, capRounded: true,
    trailLength: trail, currentTime: t, fadeTrail: true,
    parameters: { depthTest: false },
  });
}

function yearLayers() {
  const secPerSec = daysPerSec * 86400;
  const data = allTrips.filter((d) => active.has(CATS()[d.c]));
  return [pencilTrips("trips", data, secPerSec * 1.4, currentTime, 2.0, 0.8)];
}

function dayLayers() {
  if (!dayData) return [];
  const range = dayData.tMax - dayData.tMin;
  const rate = range / DAY_LOOP_SEC;
  const data = dayData.trips.filter((d) => active.has(CATS()[d.c]));
  // current vessel positions (heads of the comets) for a sense of live motion
  const heads = [];
  for (const d of data) {
    const ts = d.t;
    if (currentTime < ts[0] || currentTime > ts[ts.length - 1]) continue;
    let i = 1; while (i < ts.length && ts[i] < currentTime) i++;
    const a = d.p[i - 1], b = d.p[i] || a;
    const f = ts[i] === ts[i - 1] ? 0 : (currentTime - ts[i - 1]) / (ts[i] - ts[i - 1]);
    heads.push({ c: d.c, pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] });
  }
  return [
    pencilTrips("day-trips", data, rate * 1.6, currentTime, 2.4, 0.85),
    new deck.ScatterplotLayer({
      id: "day-heads", data: heads, getPosition: (d) => d.pos,
      getFillColor: (d) => colorFor(CATS()[d.c]), getLineColor: [40, 32, 20, 200],
      lineWidthMinPixels: 0.8, stroked: true, radiusMinPixels: 2.5, radiusMaxPixels: 6,
      getRadius: 60, parameters: { depthTest: false },
      updateTriggers: { getFillColor: [...active].join() },
    }),
  ];
}

function liveLayers() {
  const now = Date.now() / 1000;
  const dots = [...live.values()].filter((v) => active.has(v.cat) && v.lon != null);
  const trails = dots.filter((v) => v.trail.length > 1)
    .map((v) => ({ c: CATS().indexOf(v.cat), p: v.trail.map((q) => [q[0], q[1]]), t: v.trail.map((q) => q[2]) }));
  return [
    pencilTrips("live-trails", trails, 1200, now, 2, 0.8),
    new deck.ScatterplotLayer({ id: "live-dots", data: dots,
      getPosition: (d) => [d.lon, d.lat], getFillColor: (d) => colorFor(d.cat),
      getLineColor: [40, 32, 20, 200], lineWidthMinPixels: 1, stroked: true,
      getRadius: (d) => (d.cat === "cargo" || d.cat === "tanker" ? 120 : 75),
      radiusMinPixels: 3.5, radiusMaxPixels: 13, pickable: true,
      parameters: { depthTest: false }, updateTriggers: { getFillColor: [...active].join() } }),
  ];
}

// ---- Render loop --------------------------------------------------------
function tick(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1); lastFrame = now;
  if (mode === "year" && manifest) {
    if (playing) advance(dt, daysPerSec * 86400, manifest.tMin, manifest.tMax, updateYearClock);
    overlay.setProps({ layers: yearLayers() });
  } else if (mode === "day" && dayData) {
    if (playing) advance(dt, (dayData.tMax - dayData.tMin) / DAY_LOOP_SEC, dayData.tMin, dayData.tMax, updateDayClock);
    overlay.setProps({ layers: dayLayers() });
  } else if (mode === "live") {
    overlay.setProps({ layers: liveLayers() });
  }
  requestAnimationFrame(tick);
}
function advance(dt, rate, lo, hi, clockFn) {
  currentTime += rate * dt;
  if (currentTime > hi) currentTime = lo;
  $("timeline").value = Math.round((currentTime - lo) / (hi - lo) * 1000);
  clockFn();
}

const SEASONS = ["Winter", "Winter", "Spring", "Spring", "Spring", "Summer",
  "Summer", "Summer", "Autumn", "Autumn", "Autumn", "Winter"];
function updateYearClock() {
  const d = new Date(currentTime * 1000);
  $("date").textContent = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
  $("season").textContent = SEASONS[d.getMonth()] + " " + d.getFullYear();
}
function updateDayClock() {
  const d = new Date(currentTime * 1000);
  $("date").textContent = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
  $("daytime").textContent = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}

// ---- Controls -----------------------------------------------------------
$("play").onclick = () => { playing = !playing; $("play").textContent = playing ? "❚❚" : "▶"; };
$("speed").onchange = (e) => { daysPerSec = +e.target.value; };
$("timeline").oninput = (e) => {
  const f = e.target.value / 1000;
  if (mode === "year" && manifest) { currentTime = manifest.tMin + f * (manifest.tMax - manifest.tMin); updateYearClock(); }
  else if (mode === "day" && dayData) { currentTime = dayData.tMin + f * (dayData.tMax - dayData.tMin); updateDayClock(); }
};

// ---- Mode switching -----------------------------------------------------
$("mode-year").onclick = () => setMode("year");
$("mode-day").onclick = () => setMode("day");
$("mode-live").onclick = () => setMode("live");
function setMode(m) {
  if (m === mode) return;
  mode = m;
  $("mode-year").classList.toggle("active", m === "year");
  $("mode-day").classList.toggle("active", m === "day");
  $("mode-live").classList.toggle("active", m === "live");
  // show/hide controls per mode
  const show = (el, on) => { el.style.display = on ? "" : "none"; };
  show($("speed"), m === "year");
  show($("season"), m === "year");
  show($("daytime"), m === "day");
  show($("live-count"), m === "live");
  show($("play"), m !== "live");
  show($("timeline"), m !== "live");
  if (ws && m !== "live") { ws.close(); ws = null; }
  if (m === "year" && manifest) { currentTime = manifest.tMin; updateYearClock(); }
  else if (m === "day") { ensureDay().then(() => { if (dayData) { currentTime = dayData.tMin; updateDayClock(); } }); }
  else if (m === "live") connectLive();
}

// ---- Live websocket -----------------------------------------------------
function connectLive() {
  $("live-count").textContent = "connecting…";
  try { ws = new WebSocket(RELAY_URL); } catch (e) { $("live-count").textContent = "live unavailable"; return; }
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const t = Date.now() / 1000;
    let v = live.get(msg.mmsi);
    if (!v) { v = { cat: "other", name: "", trail: [] }; live.set(msg.mmsi, v); }
    if (msg.type === "pos") {
      v.lon = msg.lon; v.lat = msg.lat; v.hdg = msg.hdg; v.sog = msg.sog;
      if (msg.name) v.name = msg.name;
      v.trail.push([msg.lon, msg.lat, t]); if (v.trail.length > 60) v.trail.shift(); v.last = t;
    } else if (msg.type === "static") { if (msg.name) v.name = msg.name; v.cat = categoryFor(msg.shipType); }
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
      setTooltip(info.x, info.y, `<div class="nm">${v.name || "Unknown vessel"}</div>
        <div class="meta">${LABELS[v.cat] || v.cat}${spd ? " · " + spd : ""}</div>`);
    } else setTooltip(0, 0, null);
  },
});

// ---- Compass rose ticks -------------------------------------------------
(function compassTicks() {
  const g = document.getElementById("ticks"); if (!g) return;
  const NS = "http://www.w3.org/2000/svg";
  for (let deg = 0; deg < 360; deg += 5) {
    const major = deg % 30 === 0, len = major ? 10 : 5, r = 92, rad = deg * Math.PI / 180;
    const ln = document.createElementNS(NS, "line");
    ln.setAttribute("x1", 100 + r * Math.sin(rad)); ln.setAttribute("y1", 100 - r * Math.cos(rad));
    ln.setAttribute("x2", 100 + (r - len) * Math.sin(rad)); ln.setAttribute("y2", 100 - (r - len) * Math.cos(rad));
    ln.setAttribute("stroke-width", major ? 1.4 : 0.7); g.appendChild(ln);
  }
})();

// ---- Go -----------------------------------------------------------------
map.on("load", () => { try { addGraticule(); } catch (e) { console.warn("graticule", e); } map.resize(); });
loadData();
