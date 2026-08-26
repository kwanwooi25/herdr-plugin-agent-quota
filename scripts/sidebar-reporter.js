// Sidebar usage tokens: report a `$usage` pane-metadata token to every live
// agent pane so the Herdr sidebar renders a per-agent text gauge row, e.g.
//
//   CC 5h ▰▰▱▱▱ 44% · wk ▰▰▰▰▱ 73%
//
// Requires a `$usage` token row in [ui.sidebar.agents] rows (see README).
//
// Modes:
//   --toggle   action entrypoint: start the reporter, or stop it if running
//   --resume   startup hook: restart the reporter when it was left enabled
//   --run      the reporter loop itself (spawned detached by the other two)
//
// Which vendor quota an agent kind shows, and whether percentages are used or
// remaining, comes from <HERDR_PLUGIN_CONFIG_DIR>/sidebar.toml (seeded with
// commented defaults on first run; see lib/config.js).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || path.join(__dirname, "..", ".state");
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || null;

const SOURCE = "kwanwooi25.agent-usage";
const INTERVAL_MS = 60_000;
const TTL_MS = 5 * 60_000; // tokens vanish shortly after the reporter dies
const GAUGE_W = 5;

const pidPath = path.join(stateDir, "sidebar-reporter.pid");
const flagPath = path.join(stateDir, "sidebar-reporter.enabled");
const logPath = path.join(stateDir, "sidebar-reporter.log");

const { loadSidebarConfig } = require("../lib/config");
const SHORT = { claude: "CC", codex: "CDX", grok: "GRX" };

function run(args) {
  const r = spawnSync(herdr, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new Error(`${herdr}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`herdr ${args.join(" ")}: ${(r.stderr || r.stdout || "").trim()}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

function loadConfig() {
  return loadSidebarConfig(configDir);
}

function alivePid() {
  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf8"), 10);
    if (pid > 0) {
      process.kill(pid, 0);
      return pid;
    }
  } catch {}
  return null;
}

// ------------------------------------------------------------------ text

function gaugeText(pct) {
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.max(p > 0 ? 1 : 0, Math.round((p / 100) * GAUGE_W));
  return "\u25b0".repeat(filled) + "\u25b1".repeat(GAUGE_W - filled);
}

// Sidebar tokens per pane. Dynamic color via severity-variant tokens: each
// window slot (u1, u2) has _ok/_warn/_bad variants, statically colored in
// [ui.sidebar.agents] rows; exactly one variant per slot carries the value,
// the rest are cleared, and Herdr hides valueless tokens. `_na` carries an
// elapsed window (reset passed, no fresh sample) as a dim honest `-%`, so a
// stale fallback still shows every window instead of dropping the session
// one. `umodel` names the model an omp pane is currently running.
const SLOTS = 2;
const VARIANTS = ["ok", "warn", "bad", "na"];
const ALL_TOKENS = ["upfx"]
  .concat(Array.from({ length: SLOTS }, (_, i) => VARIANTS.map((s) => `u${i + 1}_${s}`)).flat())
  .concat(["umodel"]);

function severity(usedPct) {
  return usedPct >= 80 ? "bad" : usedPct >= 50 ? "warn" : "ok";
}

const STALE_MS = 30 * 60_000;

function fmtAge(ms) {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

function usageTokens(vendor, snap, display) {
  if (!snap || snap.windows.length === 0) return null;
  // A stale fallback sample (no live data for a while) must not wear a
  // confident severity color: render dim with its age instead.
  const stale = !snap.live && Date.now() - snap.asOfMs > STALE_MS;
  const tokens = { upfx: SHORT[vendor] };
  snap.windows.slice(0, SLOTS).forEach((w, i) => {
    if (w.resetsAt && w.resetsAt < Date.now()) {
      tokens[`u${i + 1}_na`] = `${w.label} -%`;
      return;
    }
    const used = Math.max(0, Math.min(100, w.pct));
    const shown = Math.round(display === "remaining" ? 100 - used : used);
    if (stale) {
      tokens[`u${i + 1}_na`] = `${w.label} ${shown}% \u00b7${fmtAge(snap.asOfMs)}`;
      return;
    }
    tokens[`u${i + 1}_${severity(used)}`] = `${w.label} ${gaugeText(shown)} ${shown}%`;
  });
  return tokens;
}

// ------------------------------------------------------ model detection

// omp records model_change events (and per-message model fields) in its
// session jsonl; the last occurrence in the tail is the active model.
function ompModel(sessionPath) {
  try {
    const fd = fs.openSync(sessionPath, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const matches = buf.toString("utf8").match(/"model":"([^"]+)"/g);
    if (matches) {
      const model = matches[matches.length - 1].slice(9, -1);
      return model.replace(/^[^/]*\//, ""); // drop vendor prefix
    }
  } catch {}
  return null;
}

function vendorForModel(model) {
  const m = model.toLowerCase();
  if (m.includes("claude")) return "claude";
  if (m.includes("gpt") || m.includes("codex")) return "codex";
  if (m.includes("grok")) return "grok";
  return null;
}

// ------------------------------------------------------------------ loop

async function tick(reported) {
  const { collectLimits } = require("../lib/limits");
  const limits = await collectLimits();
  process.stderr.write(
    `[${new Date().toISOString()}] limits ` +
      ["claude", "codex", "grok"]
        .map((v) => `${v}=${limits[v] ? (limits[v].live ? "live" : "file") : "none"}`)
        .join(" ") +
      "\n",
  );
  const cfg = loadConfig();
  const agents = run(["agent", "list"]).result.agents || [];
  const seq = String(Date.now());
  const seen = new Set();
  for (const a of agents) {
    if (!a.pane_id) continue;
    let vendor = cfg.kindMap[a.agent];
    let model = null;
    if (cfg.showModel && a.agent === "omp" && a.agent_session && a.agent_session.kind === "path") {
      model = ompModel(a.agent_session.value);
      if (model) vendor = vendorForModel(model) || vendor;
    }
    const tokens = vendor ? usageTokens(vendor, limits[vendor], cfg.display) : null;
    if (!tokens) continue;
    if (model) tokens.umodel = model;
    const args = ["pane", "report-metadata", a.pane_id, "--source", SOURCE, "--seq", seq, "--ttl-ms", String(TTL_MS)];
    for (const name of ALL_TOKENS) {
      if (tokens[name] !== undefined) args.push("--token", `${name}=${tokens[name]}`);
      else args.push("--clear-token", name);
    }
    try {
      run(args);
      seen.add(a.pane_id);
    } catch (e) {
      process.stderr.write(`[${new Date().toISOString()}] report ${a.pane_id}: ${e.message}\n`);
    }
  }
  reported.clear();
  for (const p of seen) reported.add(p);
}

function clearAll(reported) {
  const seq = String(Date.now());
  for (const paneId of reported) {
    const args = ["pane", "report-metadata", paneId, "--source", SOURCE, "--seq", seq];
    for (const name of ALL_TOKENS) args.push("--clear-token", name);
    try {
      run(args);
    } catch {}
  }
}

async function runMode() {
  fs.mkdirSync(stateDir, { recursive: true });
  const other = alivePid();
  if (other && other !== process.pid) process.exit(0); // already running
  fs.writeFileSync(pidPath, String(process.pid));

  const reported = new Set();
  const quit = () => {
    clearAll(reported);
    try {
      if (parseInt(fs.readFileSync(pidPath, "utf8"), 10) === process.pid) fs.rmSync(pidPath);
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);

  let busy = false;
  const safeTick = async () => {
    if (busy) return;
    busy = true;
    try {
      await tick(reported);
    } catch (e) {
      process.stderr.write(`[${new Date().toISOString()}] tick: ${e.stack || e}\n`);
    } finally {
      busy = false;
    }
  };
  await safeTick();
  setInterval(safeTick, INTERVAL_MS);
}

// ------------------------------------------------------------------ control

function spawnDetached() {
  fs.mkdirSync(stateDir, { recursive: true });
  const fd = fs.openSync(logPath, "w");
  const child = spawn(process.execPath, [__filename, "--run"], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

function toggleMode() {
  const pid = alivePid();
  if (pid) {
    process.kill(pid, "SIGTERM");
    try { fs.rmSync(flagPath); } catch {}
    process.stdout.write(`sidebar usage reporter stopped (pid ${pid})\n`);
    return;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(flagPath, "");
  const child = spawnDetached();
  process.stdout.write(`sidebar usage reporter started (pid ${child})\n`);
}

function resumeMode() {
  if (!fs.existsSync(flagPath)) return;
  if (alivePid()) return;
  spawnDetached();
}

// ------------------------------------------------------------------ entry

const mode = process.argv[2];
if (mode === "--run") {
  runMode().catch((e) => {
    process.stderr.write(String(e.stack || e) + "\n");
    process.exit(1);
  });
} else if (mode === "--resume") {
  resumeMode();
} else if (mode === "--toggle" || mode === undefined) {
  toggleMode();
} else {
  process.stderr.write("usage: sidebar-reporter.js [--toggle|--resume|--run]\n");
  process.exit(2);
}
