// Recorder loop for .github/workflows/record.yml.
//
// Why a loop: the recorder used to run on a 15-minute cron, but GitHub's
// scheduler drops and delays cron runs, and from Oct. 1, 2026 it started only
// about five of the 96 a day while every run showed green. So ONE long-lived
// job now takes a snapshot every 15 minutes, appends it to
// data/recent/YYYY-MM-DD.jsonl on the `data` branch (never main: every push to
// main triggers a full Pages rebuild, and the site doesn't read these files),
// and shortly before the job's time limit starts its own successor through
// workflow_dispatch, which is not subject to cron delays. The cron in the
// workflow is only a backstop that restarts the chain if it breaks.
//
// Usage (inside the workflow):  node recorder/loop.mjs          # loop
//                               node recorder/loop.mjs --once   # one snapshot, no successor
// Env: GH_TOKEN, REPO, GITHUB_RUN_ID; optional RUN_BUDGET_MIN (default 330).
import { snapshot, dayET } from "./ais.mjs";

const WORKFLOW = "record.yml";
const SLOT_MIN = 15;
const SNAPSHOT_COST_MS = 2 * 60_000;    // a snapshot plus its commit, with margin
const MAX_FAILURES = 4;                 // an hour of empty snapshots: fail the run loudly

const REPO = process.env.REPO;
const TOKEN = process.env.GH_TOKEN;
const RUN_ID = process.env.GITHUB_RUN_ID || "0";
const BUDGET_MS = Number(process.env.RUN_BUDGET_MIN || 330) * 60_000;
const START = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false })} ET] ${m}`);

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`); e.status = res.status; throw e; }
  return text ? JSON.parse(text) : {};
}

// Append one line to the day's log on the `data` branch, server-side.
async function archive(snap) {
  const path = `data/recent/${dayET(snap.t)}.jsonl`;
  const line = JSON.stringify(snap) + "\n";
  for (let attempt = 1; attempt <= 4; attempt++) {
    let sha, prev = "";
    try {
      const f = await gh("GET", `/contents/${path}?ref=data`);
      sha = f.sha;
      prev = Buffer.from(f.content, "base64").toString("utf8");
    } catch (e) {
      if (e.status !== 404) throw e;   // a new day: the file doesn't exist yet
    }
    try {
      await gh("PUT", `/contents/${path}`, {
        message: `log vessels ${new Date(snap.t * 1000).toISOString().replace(/\.\d+Z$/, "Z")}`,
        content: Buffer.from(prev + line).toString("base64"),
        branch: "data", ...(sha ? { sha } : {}),
        committer: { name: "harbor-recorder", email: "actions@users.noreply.github.com" },
      });
      return;
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      log(`archive write raced (attempt ${attempt}); retrying`);
      await sleep(3000 * attempt);
    }
  }
  throw new Error("could not append to the archive after 4 attempts");
}

async function recordOnce() {
  const snap = await snapshot();
  await archive(snap);
  log(`${snap.ac.length} vessels logged`);
}

if (process.argv.includes("--once")) {
  await recordOnce();
  process.exit(0);
}

let failures = 0, exitCode = 0;
try {
  while (true) {
    const slotMs = SLOT_MIN * 60_000;
    const next = Math.ceil(Date.now() / slotMs) * slotMs;
    if (next + SNAPSHOT_COST_MS - START > BUDGET_MS) break;   // hand off before the time limit
    await sleep(next - Date.now());
    try {
      await recordOnce();
      failures = 0;
    } catch (e) {
      failures++;
      console.log(`::warning::No harbor traffic recorded: ${e.message}`);
      if (failures >= MAX_FAILURES) {
        console.log(`::error::${MAX_FAILURES} snapshots in a row recorded nothing; the live feed is down`);
        exitCode = 1;
        break;
      }
    }
  }
} finally {
  try {
    await gh("POST", `/actions/workflows/${WORKFLOW}/dispatches`, { ref: "main", inputs: { predecessor: String(RUN_ID) } });
    log("successor dispatched");
  } catch (e) {
    console.log(`::error::could not dispatch a successor: ${e.message}`);
    exitCode = 1;
  }
}
process.exit(exitCode);
