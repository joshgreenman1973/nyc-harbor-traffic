/* Harbor Motion — New York Harbor boat traffic on the working NOAA nautical chart.
   Year  — a static density map of a full year (2025): every transit, by type, filterable, counted.
   A day — the most recent complete day: animate the crossings, or see the whole day at once.
   Live  — true real-time positions via AISStream, relayed by a Cloudflare Worker. */

// ---- Config -------------------------------------------------------------
const RELAY_URL = "wss://nyc-harbor-ais-relay.josh-greenman.workers.dev";
const DATA = "data/web/";
const ENC_WMS = "https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/WMSServer";
const ENC_TILES = ENC_WMS +
  "?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true" +
  "&LAYERS=0,1,2,3,4,5,6,7,8,9,10,11,12&STYLES=&CRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}";

const PALETTE = {
  passenger: [198, 58, 92], cargo: [203, 116, 50], tanker: [168, 52, 52],
  tug: [58, 120, 78], pleasure: [122, 90, 170], fishing: [196, 156, 54], other: [92, 107, 122],
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
let manifest = null, heat = null;
let dayData = null, dayLoaded = false;
const active = new Set();
let mode = "";   // set by setMode() once data is ready; 'A day' is the default
let playing = true, dayStatic = false, dayTime = 0, lastFrame = 0;
let dayLoopSec = 60;   // seconds to play one full day (set by the speed control)
let ws = null, liveStart = 0, vessels = null;
const live = new Map();
const RADAR_WINDOW = 2 * 3600;   // seconds of wake to keep (fading radar echo)
async function loadVessels() {   // MMSI -> [catIdx, name] from the 2025 archive
  if (vessels) return;
  try { vessels = await (await fetch(DATA + "vessels.json")).json(); }
  catch (e) { console.warn("vessel lookup load failed", e); vessels = {}; }
}

const $ = (id) => document.getElementById(id);
const statusEl = $("status"), statusText = $("status-text");
const showStatus = (t) => { statusText.innerHTML = t; statusEl.classList.add("show"); };
const hideStatus = () => statusEl.classList.remove("show");
const colorFor = (cat) => PALETTE[cat] || PALETTE.other;
const CATS = () => manifest.categories;
const fmt = (n) => n.toLocaleString("en-US");

// ---- Map ----------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: { enc: { type: "raster", tiles: [ENC_TILES], tileSize: 256, attribution: "Chart: NOAA ENC®" } },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#e8dab9" } },
      { id: "enc", type: "raster", source: "enc" },
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
  hideStatus();
  lastFrame = performance.now();
  requestAnimationFrame(tick);
  setMode("day");   // 'A day' is the default view (most recent complete day)
  // background-load the year heatmap so Year is instant when opened
  fetch(DATA + "heat.json").then((r) => r.json())
    .then((h) => { heat = h; if (mode === "year") renderStatic(); })
    .catch((e) => console.warn("heat load failed", e));
}
async function ensureDay() {
  if (dayLoaded) return;
  showStatus('<span class="spin"></span>Loading the day…');
  try { dayData = await (await fetch(DATA + "day.json")).json(); dayLoaded = true; }
  catch (e) { console.warn("day load failed", e); }
  hideStatus();
  if (mode === "day" && dayData) { dayTime = dayData.tMin; setDayNote(); updateCounts(); updateDayClock(); renderStatic(); }
}

// ---- Legend with counts -------------------------------------------------
function buildLegend() {
  const el = $("legend"); el.innerHTML = "";
  manifest.categories.forEach((c) => {
    const col = colorFor(c);
    const chip = document.createElement("div");
    chip.className = "chip"; chip.dataset.cat = c;
    chip.innerHTML = `<span class="dot" style="background:rgb(${col})"></span>${LABELS[c] || c}<span class="cnt"></span>`;
    chip.onclick = () => {
      if (active.has(c)) { active.delete(c); chip.classList.add("off"); }
      else { active.add(c); chip.classList.remove("off"); }
      renderStatic();
    };
    el.appendChild(chip);
  });
  updateCounts();
}
function updateCounts() {
  const src = mode === "day" ? (dayData && dayData.counts) : (mode === "year" ? manifest.counts : null);
  document.querySelectorAll("#legend .chip").forEach((chip) => {
    const c = chip.dataset.cat;
    const span = chip.querySelector(".cnt");
    span.textContent = src && src[c] ? fmt(src[c].vessels) : "";
  });
}

// ---- Layers -------------------------------------------------------------
function densityPaths(id, data, opacity, width) {
  return new deck.PathLayer({
    id, data, getPath: (d) => d.p, getColor: (d) => colorFor(CATS()[d.c]),
    widthMinPixels: width, opacity, capRounded: true, jointRounded: true,
    parameters: { depthTest: false }, updateTriggers: { getColor: [...active].join() },
  });
}
// Year = density heatmap of where traffic concentrates over the whole year.
const HEAT_RANGE = [
  [255, 247, 188], [254, 217, 118], [254, 153, 41],
  [236, 112, 20], [204, 56, 30], [153, 18, 38],
];
function yearLayers() {
  if (!heat) return [];
  const res = heat.res, lon0 = heat.lon0, lat0 = heat.lat0;
  const idx = [...active].map((c) => heat.cats.indexOf(c)).filter((i) => i >= 0);
  const pts = [];
  for (const cell of heat.cells) {
    let w = 0; for (const i of idx) w += cell[2 + i];
    if (w > 0) pts.push({ pos: [lon0 + (cell[0] + 0.5) * res, lat0 + (cell[1] + 0.5) * res], w });
  }
  return [new deck.HeatmapLayer({
    id: "year-heat", data: pts, getPosition: (d) => d.pos, getWeight: (d) => d.w,
    aggregation: "SUM", radiusPixels: 11, intensity: 1.6, threshold: 0.06,
    colorRange: HEAT_RANGE, parameters: { depthTest: false },
  })];
}
function dayAnimLayers() {
  const data = dayData.trips.filter((d) => active.has(CATS()[d.c]));
  const rate = (dayData.tMax - dayData.tMin) / dayLoopSec;
  const heads = [];
  for (const d of data) {
    const ts = d.t;
    if (dayTime < ts[0] || dayTime > ts[ts.length - 1]) continue;
    let i = 1; while (i < ts.length && ts[i] < dayTime) i++;
    const a = d.p[i - 1], b = d.p[i] || a;
    const f = ts[i] === ts[i - 1] ? 0 : (dayTime - ts[i - 1]) / (ts[i] - ts[i - 1]);
    heads.push({ c: d.c, pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] });
  }
  return [
    new deck.TripsLayer({
      id: "day-anim", data, getPath: (d) => d.p, getTimestamps: (d) => d.t,
      getColor: (d) => colorFor(CATS()[d.c]), opacity: 0.9, widthMinPixels: 2.4,
      jointRounded: true, capRounded: true, trailLength: rate * 1.6, currentTime: dayTime,
      fadeTrail: true, parameters: { depthTest: false },
    }),
    new deck.ScatterplotLayer({
      id: "day-heads", data: heads, getPosition: (d) => d.pos,
      getFillColor: (d) => colorFor(CATS()[d.c]), getLineColor: [40, 32, 20, 200],
      lineWidthMinPixels: 0.8, stroked: true, radiusMinPixels: 2.5, radiusMaxPixels: 6, getRadius: 60,
      parameters: { depthTest: false }, updateTriggers: { getFillColor: [...active].join() },
    }),
  ];
}
function dayStaticLayers() {
  const data = dayData.trips.filter((d) => active.has(CATS()[d.c]));
  return [densityPaths("day-static", data, 0.5, 1.4)];
}
function liveLayers() {
  const now = Date.now() / 1000;
  const all = [...live.values()].filter((v) => active.has(v.cat));
  // wakes: every vessel with a recent track, fading over the radar window
  const trails = all.filter((v) => v.trail.length > 1)
    .map((v) => ({ c: CATS().indexOf(v.cat), p: v.trail.map((q) => [q[0], q[1]]), t: v.trail.map((q) => q[2]) }));
  // bright heads: vessels that pinged in the last ~15 min
  const dots = all.filter((v) => v.lon != null && now - (v.last || 0) < 900);
  return [
    // soft glow underlay
    new deck.TripsLayer({ id: "radar-glow", data: trails, getPath: (d) => d.p, getTimestamps: (d) => d.t,
      getColor: (d) => colorFor(CATS()[d.c]), opacity: 0.22, widthMinPixels: 6,
      capRounded: true, jointRounded: true, trailLength: RADAR_WINDOW, currentTime: now, fadeTrail: true,
      parameters: { depthTest: false } }),
    // the wake itself
    new deck.TripsLayer({ id: "radar-wake", data: trails, getPath: (d) => d.p, getTimestamps: (d) => d.t,
      getColor: (d) => colorFor(CATS()[d.c]), opacity: 0.85, widthMinPixels: 1.8,
      capRounded: true, jointRounded: true, trailLength: RADAR_WINDOW, currentTime: now, fadeTrail: true,
      parameters: { depthTest: false } }),
    // halo so each vessel is easy to spot on the busy chart
    new deck.ScatterplotLayer({ id: "live-halo", data: dots, getPosition: (d) => [d.lon, d.lat],
      getFillColor: (d) => { const c = colorFor(d.cat); return [c[0], c[1], c[2], 55]; },
      stroked: false, getRadius: 250, radiusMinPixels: 12, radiusMaxPixels: 30,
      parameters: { depthTest: false }, updateTriggers: { getFillColor: [...active].join() } }),
    new deck.ScatterplotLayer({ id: "live-dots", data: dots, getPosition: (d) => [d.lon, d.lat],
      getFillColor: (d) => colorFor(d.cat), getLineColor: [18, 28, 44, 235], lineWidthMinPixels: 1.4, stroked: true,
      getRadius: (d) => (d.cat === "cargo" || d.cat === "tanker" ? 170 : 110), radiusMinPixels: 5.5, radiusMaxPixels: 17,
      pickable: true, parameters: { depthTest: false }, updateTriggers: { getFillColor: [...active].join() } }),
  ];
}

// ---- Rendering ----------------------------------------------------------
// Static modes (year, day-static) render on demand; animated modes per frame.
function renderStatic() {
  if (mode === "year") overlay.setProps({ layers: yearLayers() });
  else if (mode === "day" && dayData && dayStatic) overlay.setProps({ layers: dayStaticLayers() });
}
function tick(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1); lastFrame = now;
  if (mode === "day" && dayData && !dayStatic) {
    if (playing) {
      const rate = (dayData.tMax - dayData.tMin) / dayLoopSec;
      dayTime += rate * dt;
      if (dayTime > dayData.tMax) dayTime = dayData.tMin;
      $("timeline").value = Math.round((dayTime - dayData.tMin) / (dayData.tMax - dayData.tMin) * 1000);
      updateDayClock();
    }
    overlay.setProps({ layers: dayAnimLayers() });
  } else if (mode === "live") {
    overlay.setProps({ layers: liveLayers() });
  }
  requestAnimationFrame(tick);
}

// ---- Labels -------------------------------------------------------------
function setYearLabel() {
  $("date").textContent = "2025";
  const tot = manifest.counts && manifest.counts._total;
  $("season").textContent = tot ? `${fmt(tot.vessels)} vessels · ${fmt(tot.transits)} vessel-days` : "by vessel type";
}
function setDayNote() {
  // Compute the real lag so the note can't claim a wrong duration.
  const lagDays = Math.max(0, Math.round((Date.now() / 1000 - dayData.tMin) / 86400));
  let lag;
  if (lagDays <= 24) lag = `about ${lagDays} days`;
  else if (lagDays < 75) lag = "a few weeks";
  else lag = `about ${Math.round(lagDays / 30)} months`;
  $("daynote").textContent = `· latest day in the public NOAA AIS archive (it runs ${lag} behind)`;
}
function updateDayClock() {
  const d0 = new Date(dayData.tMin * 1000);
  $("date").textContent = d0.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
  if (dayStatic) { $("daytime").textContent = "whole day"; return; }
  const d = new Date(dayTime * 1000);
  $("daytime").textContent = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}

// ---- Controls -----------------------------------------------------------
$("play").onclick = () => { playing = !playing; $("play").textContent = playing ? "❚❚" : "▶"; };
$("timeline").oninput = (e) => {
  if (mode !== "day" || !dayData) return;
  dayTime = dayData.tMin + (e.target.value / 1000) * (dayData.tMax - dayData.tMin);
  updateDayClock();
  if (dayStatic) renderStatic();
};
$("speed").onchange = (e) => { dayLoopSec = +e.target.value; };
$("daytoggle").onclick = () => {
  dayStatic = !dayStatic;
  $("daytoggle").classList.toggle("on", dayStatic);
  $("daytoggle").textContent = dayStatic ? "Animate" : "Whole day";
  const vis = (el, on) => (el.style.display = on ? "" : "none");
  vis($("play"), !dayStatic); vis($("timeline"), !dayStatic); vis($("speed"), !dayStatic);
  updateDayClock();
  renderStatic();
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
  const vis = (el, on) => (el.style.display = on ? "" : "none");
  vis($("date"), m !== "live");
  vis($("season"), m === "year");
  vis($("daytime"), m === "day");
  vis($("daynote"), m === "day");
  vis($("live-count"), m === "live");
  vis($("daytoggle"), m === "day");
  vis($("speed"), m === "day" && !dayStatic);
  vis($("play"), m === "day" && !dayStatic);
  vis($("timeline"), m === "day" && !dayStatic);
  if (ws && m !== "live") { ws.close(); ws = null; }
  updateCounts();
  overlay.setProps({ layers: [] });
  if (m === "year") { setYearLabel(); renderStatic(); }
  else if (m === "day") {
    ensureDay().then(() => { if (dayData) { dayTime = dayData.tMin; setDayNote(); updateDayClock(); updateCounts(); renderStatic(); } });
  }
  else if (m === "live") connectLive();
}

// ---- Live websocket -----------------------------------------------------
function connectLive() {
  $("live-count").textContent = "connecting…";
  if (!liveStart) liveStart = Date.now();
  loadVessels();
  try { ws = new WebSocket(RELAY_URL); } catch (e) { $("live-count").textContent = "live unavailable"; return; }
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const t = Date.now() / 1000;
    let v = live.get(msg.mmsi);
    if (!v) { v = { cat: "other", name: "", trail: [], __mmsi: msg.mmsi }; live.set(msg.mmsi, v); }
    // fill type/name instantly from the 2025 archive until AIS static data arrives
    if (vessels && (v.cat === "other" || !v.name)) {
      const lk = vessels[msg.mmsi];
      if (lk) { if (v.cat === "other") v.cat = CATS()[lk[0]] || "other"; if (!v.name) v.name = lk[1] || ""; }
    }
    if (msg.type === "pos") {
      v.lon = msg.lon; v.lat = msg.lat; v.hdg = msg.hdg; v.sog = msg.sog; v.cog = msg.cog; v.nav = msg.nav;
      if (msg.name) v.name = msg.name;
      v.trail.push([msg.lon, msg.lat, t]);
      const cut = t - RADAR_WINDOW;
      while (v.trail.length && v.trail[0][2] < cut) v.trail.shift();
      v.last = t;
    } else if (msg.type === "static") {
      if (msg.name) v.name = msg.name;
      v.cat = categoryFor(msg.shipType);
      v.dest = msg.dest; v.callsign = msg.callsign; v.imo = msg.imo;
      v.length = msg.length; v.width = msg.width; v.draught = msg.draught;
    }
  };
  ws.onclose = () => { if (mode === "live") $("live-count").textContent = "disconnected"; };
  ws.onerror = () => { $("live-count").textContent = "live unavailable"; };
  setInterval(() => {
    if (mode !== "live") return;
    const now = Date.now() / 1000, cut = now - RADAR_WINDOW;
    let activeNow = 0;
    for (const [k, v] of live) {
      while (v.trail.length && v.trail[0][2] < cut) v.trail.shift();
      if (v.trail.length === 0 && now - (v.last || 0) > RADAR_WINDOW) { live.delete(k); continue; }
      if (now - (v.last || 0) < 900) activeNow++;
    }
    const since = new Date(liveStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
    $("live-count").textContent = `${activeNow} vessels now · tracking since ${since}`;
  }, 2000);
}

// ---- Hover tooltip ------------------------------------------------------
const NAV = {
  0: "Under way", 1: "At anchor", 2: "Not under command", 3: "Restricted manoeuvrability",
  4: "Constrained by draught", 5: "Moored", 6: "Aground", 7: "Fishing", 8: "Under way (sailing)",
};
const ago = (sec) => { const s = Math.max(0, Math.round(Date.now() / 1000 - sec));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`; };
overlay.setProps({
  onHover: (info) => {
    if (mode === "live" && info.object && info.layer && info.layer.id === "live-dots") {
      const v = info.object, L = [];
      L.push(`<div class="nm">${v.name || "Unknown vessel"}</div>`);
      L.push(`<div class="meta">${LABELS[v.cat] || v.cat}${v.nav != null && NAV[v.nav] ? " · " + NAV[v.nav] : ""}</div>`);
      const mv = [];
      if (v.sog != null) mv.push(`${v.sog.toFixed(1)} kn`);
      if (v.cog != null && v.sog > 0.5) mv.push(`course ${Math.round(v.cog)}°`);
      if (mv.length) L.push(`<div class="meta">${mv.join(" · ")}</div>`);
      if (v.dest) L.push(`<div class="meta">→ ${v.dest}</div>`);
      if (v.length) L.push(`<div class="meta">${v.length}×${v.width} m${v.draught ? " · " + v.draught + " m draught" : ""}</div>`);
      L.push(`<div class="meta">seen ${ago(v.last)} · MMSI ${info.object.__mmsi || ""}</div>`);
      setTooltip(info.x, info.y, L.join(""));
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
// Default controls are hidden until setMode() configures them for 'A day'.
$("season").style.display = "none"; $("live-count").style.display = "none";
loadData();
