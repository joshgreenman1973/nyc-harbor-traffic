// Cloudflare Worker: live AIS relay for the NYC harbor.
//
// The browser opens a WebSocket to this Worker. The Worker holds the AISStream
// API key as a secret (never exposed to the client), opens an upstream
// WebSocket to AISStream, subscribes to the harbor bounding box, and relays
// PositionReport / ShipStaticData messages back to the browser.

// Harbor bbox -- keep in sync with pipeline/harbor.py.
// AISStream expects [[[lat, lon], [lat, lon]], ...]  (south-west, north-east).
const BBOX = [[[40.45, -74.28], [40.92, -73.70]]];

export default {
  async fetch(request, env) {
    const upgrade = request.headers.get("Upgrade") || "";
    if (upgrade.toLowerCase() !== "websocket") {
      return new Response(
        "NYC Harbor Traffic live relay. Connect via WebSocket.",
        { status: 426, headers: { "content-type": "text/plain" } }
      );
    }
    if (!env.AISSTREAM_KEY) {
      return new Response("Relay not configured: missing AISSTREAM_KEY", { status: 500 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let upstream;
    try {
      const resp = await fetch("https://stream.aisstream.io/v0/stream", {
        headers: { Upgrade: "websocket" },
      });
      upstream = resp.webSocket;
      if (!upstream) throw new Error("no upstream webSocket");
      upstream.accept();
    } catch (e) {
      server.send(JSON.stringify({ type: "error", message: "upstream connect failed" }));
      server.close(1011, "upstream");
      return new Response(null, { status: 101, webSocket: client });
    }

    // Subscribe once upstream is ready.
    upstream.send(JSON.stringify({
      APIKey: env.AISSTREAM_KEY,
      BoundingBoxes: BBOX,
      FilterMessageTypes: ["PositionReport", "ShipStaticData"],
    }));

    // Relay upstream -> client, trimmed to the fields the frontend needs.
    const decoder = new TextDecoder();
    upstream.addEventListener("message", (evt) => {
      try {
        // AISStream delivers JSON as binary frames; decode bytes to text first.
        const raw = typeof evt.data === "string" ? evt.data : decoder.decode(evt.data);
        const msg = JSON.parse(raw);
        const meta = msg.MetaData || {};
        const type = msg.MessageType;
        if (type === "PositionReport") {
          const r = msg.Message.PositionReport;
          server.send(JSON.stringify({
            type: "pos",
            mmsi: meta.MMSI,
            lat: r.Latitude, lon: r.Longitude,
            cog: r.Cog, sog: r.Sog, hdg: r.TrueHeading,
            name: (meta.ShipName || "").trim(),
          }));
        } else if (type === "ShipStaticData") {
          const s = msg.Message.ShipStaticData;
          server.send(JSON.stringify({
            type: "static",
            mmsi: meta.MMSI,
            name: (s.Name || meta.ShipName || "").trim(),
            shipType: s.Type,
          }));
        }
      } catch (_) { /* ignore malformed */ }
    });

    const closeBoth = () => { try { upstream.close(); } catch (_) {} try { server.close(); } catch (_) {} };
    upstream.addEventListener("close", closeBoth);
    upstream.addEventListener("error", closeBoth);
    server.addEventListener("close", () => { try { upstream.close(); } catch (_) {} });

    return new Response(null, { status: 101, webSocket: client });
  },
};
