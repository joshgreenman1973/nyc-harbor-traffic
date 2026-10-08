// Shared by recorder/loop.mjs: snapshot live NYC harbor vessels through the
// Cloudflare relay (so no API key is needed here; the key stays in the Worker).
// NOAA's free archive is annual and live history is otherwise a paid product,
// so these snapshots build our own rolling recent history.

const RELAY = "wss://nyc-harbor-ais-relay.josh-greenman.workers.dev";
const LISTEN_MS = 30000;

// Listens for LISTEN_MS and returns {t, ac}. Throws if the feed is broken. A dead
// relay and a still harbor look identical once written to disk: both are
// `ac: []`. New York Harbor is never empty, so an empty snapshot means a broken
// feed and is never recorded, rather than appending a fresh timestamp over a
// silence that would go unnoticed for months.
export async function snapshot() {
  const v = new Map();
  let opened = false, messages = 0, wsError = null, relayError = null;
  const ws = new WebSocket(RELAY);
  ws.addEventListener("open", () => { opened = true; });
  ws.addEventListener("message", (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    // The relay forwards AISStream's own error (e.g. a rejected key) as {type: "error"}.
    if (m.type === "error") { relayError = m.message || "unknown error"; return; }
    messages++;
    let o = v.get(m.mmsi); if (!o) { o = {}; v.set(m.mmsi, o); }
    if (m.type === "pos") { o.lat = m.lat; o.lon = m.lon; o.sog = m.sog; o.cog = m.cog; if (m.name) o.name = m.name; }
    else if (m.type === "static") { if (m.name) o.name = m.name; o.st = m.shipType; }
  });
  ws.addEventListener("error", (e) => { wsError = e?.message || String(e); });

  await new Promise((r) => setTimeout(r, LISTEN_MS));
  try { ws.close(); } catch {}

  const t = Math.floor(Date.now() / 1000);
  const ac = [...v.entries()].filter(([, o]) => o.lat != null).map(([mmsi, o]) => ({
    m: mmsi, la: +o.lat.toFixed(4), lo: +o.lon.toFixed(4),
    sg: o.sog != null ? Math.round(o.sog * 10) / 10 : null, st: o.st ?? null, nm: o.name || "",
  }));
  if (relayError) throw new Error(`the AIS source reported an error: ${relayError}`);
  if (!opened) throw new Error(`never connected to the relay${wsError ? ` (${wsError})` : ""}`);
  if (messages === 0) throw new Error(`connected but received no AIS messages in ${LISTEN_MS / 1000}s`);
  if (ac.length === 0) throw new Error(`received ${messages} message(s) but no vessel had a position`);
  return { t, ac };
}

// YYYY-MM-DD in New York time.
export const dayET = (t) => new Date(t * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
