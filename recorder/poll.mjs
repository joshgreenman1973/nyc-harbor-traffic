// Snapshot live NYC harbor vessels and append to a per-day log, building our own
// rolling recent history (NOAA's free archive is annual; live history is otherwise
// a paid product). Connects to the existing Cloudflare relay so no API key is
// needed here — the key stays in the Worker.
import fs from "node:fs";

const RELAY = "wss://nyc-harbor-ais-relay.josh-greenman.workers.dev";
const LISTEN_MS = 30000;

const v = new Map();
let opened = false;
let messages = 0;
let wsError = null;
const ws = new WebSocket(RELAY);
ws.addEventListener("open", () => { opened = true; });
ws.addEventListener("message", (ev) => {
  messages++;
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  let o = v.get(m.mmsi); if (!o) { o = {}; v.set(m.mmsi, o); }
  if (m.type === "pos") { o.lat = m.lat; o.lon = m.lon; o.sog = m.sog; o.cog = m.cog; if (m.name) o.name = m.name; }
  else if (m.type === "static") { if (m.name) o.name = m.name; o.st = m.shipType; }
});
ws.addEventListener("error", (e) => { wsError = e?.message || String(e); console.warn("ws error", wsError); });

await new Promise((r) => setTimeout(r, LISTEN_MS));
try { ws.close(); } catch {}

const t = Math.floor(Date.now() / 1000);
const ac = [...v.entries()].filter(([, o]) => o.lat != null).map(([mmsi, o]) => ({
  m: mmsi, la: +o.lat.toFixed(4), lo: +o.lon.toFixed(4),
  sg: o.sog != null ? Math.round(o.sog * 10) / 10 : null, st: o.st ?? null, nm: o.name || "",
}));
// A dead relay and a still harbor look identical once written to disk: both are
// `ac: []`. New York harbor is never empty, so treat an empty snapshot as a
// broken feed and record nothing, rather than appending a fresh timestamp over
// a silence that would go unnoticed for months.
if (!opened || messages === 0 || ac.length === 0) {
  const why = !opened
    ? `never connected to the relay${wsError ? ` (${wsError})` : ""}`
    : messages === 0
      ? "connected but received no AIS messages in 30s"
      : `received ${messages} message(s) but no vessel had a position`;
  console.error(`No harbor traffic recorded: ${why}. Refusing to log an empty snapshot.`);
  process.exit(1);
}

const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
fs.mkdirSync("data/recent", { recursive: true });
fs.appendFileSync(`data/recent/${day}.jsonl`, JSON.stringify({ t, ac }) + "\n");
console.log(`${day}  ${ac.length} vessels logged`);
process.exit(0);
