// Rate-limit snapshots for Claude Code, Codex, Grok, and Antigravity.
//
// Live sources (preferred; each uses the CLI's own OAuth login state):
//   Claude: GET https://api.anthropic.com/api/oauth/usage with the Claude Code
//     OAuth token (macOS Keychain "Claude Code-credentials", falling back to
//     ~/.claude/.credentials.json). Claude Code refreshes this token itself
//     whenever it runs.
//   Codex:  GET https://chatgpt.com/backend-api/wham/usage with the tokens in
//     ~/.codex/auth.json (long-lived; refreshed by the codex CLI on use).
//   Grok:   the `_x.ai/billing` ACP extension over `grok agent stdio` -- the
//     CLI authenticates with its own stored OAuth session and refreshes
//     tokens itself, so login state is never touched by this plugin.
//   Antigravity: `agy -p /usage --output-format json` -- the CLI answers from
//     its own login without calling a model (no tokens spent, no
//     conversation recorded). Quotas come in model groups (Gemini,
//     Claude/GPT, Argon), each with its own 5-hour and/or weekly window.
// File fallbacks (last-known values when offline or tokens are unavailable):
//   Claude: rate_limits in statusline payloads cached by the HUD under
//     ~/.claude/hud/cache/stdin.*.json.
//   Codex:  rate_limits on token_count events in recent rollout files.
//   Grok:   none (the CLI records no quota data locally).
//   Antigravity: none.
//
// Tokens never leave the machine except toward their own vendor's API.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile, execFileSync, spawn } = require("node:child_process");

const FETCH_TTL_MS = 5 * 60_000; // refetch live data at most every 5 minutes
const FETCH_TIMEOUT_MS = 5_000;

function home(env, fallback) {
  const v = process.env[env];
  return v && v.trim() ? v : path.join(os.homedir(), fallback);
}

function windowLabel(minutes) {
  if (!minutes) return "?";
  if (minutes <= 1440 * 2) return `${Math.round(minutes / 60)}h`;
  return "wk";
}

function resetEpoch(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : Math.max(0, value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) return resetEpoch(Number(trimmed));
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function compactLimitLabel(value, fallback) {
  const clean = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (clean || fallback).slice(0, 10);
}

function currentClaudeLimitLabel(limit) {
  if (limit.kind === "session") return "5h";
  if (limit.kind === "weekly_all") return "wk";
  if (limit.kind === "weekly_scoped") {
    const scope = limit.scope && typeof limit.scope === "object" ? limit.scope : {};
    const model = scope.model && typeof scope.model === "object" ? scope.model : {};
    return compactLimitLabel(
      model.display_name || model.name || model.id || scope.display_name || scope.name || scope.id,
      "scope",
    );
  }
  return compactLimitLabel(limit.display_name || limit.label || limit.kind, "limit");
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// Memoize live results (and token lookups) between refresh ticks.
const memo = { claude: null, codex: null, grok: null, agy: null };

function fresh(slot) {
  const m = memo[slot];
  return m && Date.now() - m.at < FETCH_TTL_MS ? m.snap : undefined;
}

function remember(slot, snap) {
  memo[slot] = { at: Date.now(), snap };
  if (snap && snap.live) diskRemember(slot, snap);
  return snap;
}

// Persist the last live snapshot so a failed live fetch (offline, transient
// 429) prefers recent live data over much older file fallbacks.
function liveCachePath() {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR;
  return dir ? path.join(dir, "live-limits.json") : null;
}

function loadDisk() {
  const p = liveCachePath();
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function saveDisk(all) {
  const p = liveCachePath();
  if (!p) return;
  try {
    fs.writeFileSync(p, JSON.stringify(all));
  } catch {}
}

function diskRemember(slot, snap) {
  const all = loadDisk();
  if (!all) return;
  all[slot] = snap;
  saveDisk(all);
}

function diskRecall(slot) {
  const all = loadDisk();
  const snap = all && all[slot];
  return snap && Array.isArray(snap.windows) ? snap : null;
}

// Cross-process attempt throttle: one-shot invocations (tab bar command,
// `--oneline`, `--report`) have no in-memory memo, so without this a failing
// endpoint gets retried every invocation — which is exactly how a transient
// 429 turns into a persistent one. Any process records the attempt before
// fetching; everyone skips live for FETCH_TTL_MS after the last attempt.
function shouldAttempt(slot) {
  const all = loadDisk();
  if (!all) return true; // no state dir: plain CLI use, no shared throttle
  const at = all._attempts && all._attempts[slot];
  return !(at && Date.now() - at < FETCH_TTL_MS);
}

function markAttempt(slot) {
  const all = loadDisk();
  if (!all) return;
  all._attempts = all._attempts || {};
  all._attempts[slot] = Date.now();
  saveDisk(all);
}


// Cross-process fetch guard: a live snapshot on disk younger than FETCH_TTL_MS
// is served instead of refetching, so reporter restarts don't hammer (and get
// rate-limited by) the vendor endpoints.
function diskFresh(slot) {
  const snap = diskRecall(slot);
  if (snap && snap.live && Date.now() - snap.asOfMs < FETCH_TTL_MS) {
    memo[slot] = { at: Date.now(), snap };
    return snap;
  }
  return undefined;
}
// Pick whichever fallback is newer; cached live snapshots lose their `live`
// flag so staleness markers still apply.
function bestFallback(slot, fileSnap) {
  const cached = diskRecall(slot);
  if (cached && (!fileSnap || cached.asOfMs > fileSnap.asOfMs)) {
    return { ...cached, live: false };
  }
  return fileSnap;
}

// ---------------------------------------------------------------- claude

function claudeToken() {
  // Keychain first (where Claude Code stores credentials on macOS).
  if (process.platform === "darwin") {
    try {
      const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
      const oauth = JSON.parse(raw).claudeAiOauth;
      if (oauth && oauth.accessToken && (!oauth.expiresAt || oauth.expiresAt > Date.now())) {
        return oauth.accessToken;
      }
    } catch {
      // locked keychain or missing item; try the file
    }
  }
  try {
    const file = path.join(home("CLAUDE_CONFIG_DIR", ".claude"), ".credentials.json");
    const oauth = JSON.parse(fs.readFileSync(file, "utf8")).claudeAiOauth;
    if (oauth && oauth.accessToken && (!oauth.expiresAt || oauth.expiresAt > Date.now())) {
      return oauth.accessToken;
    }
  } catch {
    // no usable credentials
  }
  return null;
}

async function claudeLive() {
  const token = claudeToken();
  if (!token) return null;
  const data = await getJson("https://api.anthropic.com/api/oauth/usage", {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
  });
  const windows = [];

  // Current responses enumerate all quota windows here, including
  // model-scoped weekly limits. A successfully parsed array is authoritative:
  // parsing the legacy fields too would duplicate the session and all-model
  // windows. Malformed arrays still fall through to the legacy named fields.
  if (Array.isArray(data.limits) && data.limits.length > 0) {
    for (const limit of data.limits) {
      if (!limit || typeof limit !== "object" || !Number.isFinite(limit.percent)) continue;
      windows.push({
        label: currentClaudeLimitLabel(limit),
        pct: limit.percent,
        resetsAt: resetEpoch(limit.resets_at),
      });
    }
    if (windows.length) return { windows, asOfMs: Date.now(), live: true };
  }

  // Older API payloads expose named objects instead of `limits`.
  const push = (label, w) => {
    if (w && typeof w.utilization === "number") {
      windows.push({ label, pct: w.utilization, resetsAt: resetEpoch(w.resets_at) });
    }
  };
  push("5h", data.five_hour);
  push("wk", data.seven_day);
  for (const [key, value] of Object.entries(data)) {
    const m = /^seven_day_(.+)$/.exec(key);
    if (m && value && typeof value.utilization === "number") {
      push(compactLimitLabel(m[1], "scope"), value);
    }
  }
  return windows.length ? { windows, asOfMs: Date.now(), live: true } : null;
}

function claudeFromHud() {
  const dir = path.join(home("CLAUDE_CONFIG_DIR", ".claude"), "hud", "cache");
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith("stdin.") && n.endsWith(".json"));
  } catch {
    return null;
  }
  const files = [];
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      files.push({ p, mtimeMs: fs.statSync(p).mtimeMs });
    } catch {
      // removed while scanning
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Newest payloads first; accept the first one whose weekly window is still
  // current (some cached payloads hold stale rate_limits despite fresh mtimes).
  const nowSec = Date.now() / 1000;
  let fallback = null;
  for (const { p, mtimeMs } of files.slice(0, 100)) {
    let rl;
    try {
      rl = JSON.parse(fs.readFileSync(p, "utf8")).rate_limits;
    } catch {
      continue;
    }
    if (!rl || typeof rl !== "object") continue;
    const windows = [];
    for (const [key, label] of [
      ["five_hour", "5h"],
      ["seven_day", "wk"],
    ]) {
      const w = rl[key];
      if (w && typeof w.used_percentage === "number") {
        windows.push({ label, pct: w.used_percentage, resetsAt: (w.resets_at || 0) * 1000 });
      }
    }
    if (windows.length === 0) continue;
    const snap = { windows, asOfMs: mtimeMs };
    if (!fallback) fallback = snap;
    const seven = windows.find((w) => w.label === "wk");
    if (seven && seven.resetsAt / 1000 > nowSec) return snap;
  }
  return fallback;
}

async function claudeLimits() {
  const cached = fresh("claude");
  if (cached !== undefined) return cached;
  const disk = diskFresh("claude");
  if (disk !== undefined) return disk;
  if (shouldAttempt("claude")) {
    markAttempt("claude");
    try {
      const live = await claudeLive();
      if (live) return remember("claude", live);
    } catch {
      // offline or rate-limited; fall back to files
    }
  }
  return remember("claude", bestFallback("claude", claudeFromHud()));
}

// ---------------------------------------------------------------- codex

async function codexLive() {
  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(path.join(home("CODEX_HOME", ".codex"), "auth.json"), "utf8")).tokens;
  } catch {
    return null;
  }
  if (!tokens || !tokens.access_token) return null;
  const data = await getJson("https://chatgpt.com/backend-api/wham/usage", {
    Authorization: `Bearer ${tokens.access_token}`,
    "chatgpt-account-id": tokens.account_id || "",
  });
  const rl = data.rate_limit;
  if (!rl) return null;
  const windows = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const w = rl[key];
    if (w && typeof w.used_percent === "number") {
      windows.push({
        label: windowLabel((w.limit_window_seconds || 0) / 60),
        pct: w.used_percent,
        resetsAt: (w.reset_at || 0) * 1000,
      });
    }
  }
  return windows.length ? { windows, asOfMs: Date.now(), live: true } : null;
}

function codexFromRollouts() {
  const root = path.join(home("CODEX_HOME", ".codex"), "sessions");
  const files = [];
  (function walk(dir) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.startsWith("rollout-") && ent.name.endsWith(".jsonl")) {
        try {
          files.push({ p, mtimeMs: fs.statSync(p).mtimeMs });
        } catch {
          // removed while scanning
        }
      }
    }
  })(root);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { p, mtimeMs } of files.slice(0, 5)) {
    let best = null;
    let text;
    try {
      text = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"rate_limits"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const pay = o.payload;
      if (!pay || pay.type !== "token_count" || !pay.rate_limits) continue;
      best = { rl: pay.rate_limits, ts: Date.parse(o.timestamp) || mtimeMs };
    }
    if (!best) continue;
    const windows = [];
    for (const key of ["primary", "secondary"]) {
      const w = best.rl[key];
      if (w && typeof w.used_percent === "number") {
        windows.push({
          label: windowLabel(w.window_minutes),
          pct: w.used_percent,
          resetsAt: (w.resets_at || 0) * 1000,
        });
      }
    }
    if (windows.length === 0) continue;
    return { windows, asOfMs: best.ts };
  }
  return null;
}

async function codexLimits() {
  const cached = fresh("codex");
  if (cached !== undefined) return cached;
  const disk = diskFresh("codex");
  if (disk !== undefined) return disk;
  if (shouldAttempt("codex")) {
    markAttempt("codex");
    try {
      const live = await codexLive();
      if (live) return remember("codex", live);
    } catch {
      // offline or rate-limited; fall back to files
    }
  }
  return remember("codex", bestFallback("codex", codexFromRollouts()));
}


// ---------------------------------------------------------------- grok

// The grok CLI exposes account billing through the `_x.ai/billing` ACP
// extension. Speak minimal JSON-RPC to a short-lived `grok agent stdio`
// process; the CLI handles OAuth (including token refresh) itself.
function grokBillingViaAcp() {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn("grok", ["agent", "stdio"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    let buf = "";
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        p.kill();
      } catch {
        // already gone
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 20_000);
    const send = (o) => {
      try {
        p.stdin.write(JSON.stringify(o) + "\n");
      } catch {
        finish(null);
      }
    };
    p.on("error", () => finish(null));
    p.on("exit", () => finish(null));
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) send({ jsonrpc: "2.0", id: 2, method: "_x.ai/billing", params: {} });
        else if (m.id === 2) finish(m.result || null);
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
    });
  });
}

function grokPeriodLabel(type) {
  if (type === "USAGE_PERIOD_TYPE_WEEKLY") return "wk";
  if (type === "USAGE_PERIOD_TYPE_MONTHLY") return "mo";
  if (type === "USAGE_PERIOD_TYPE_DAILY") return "1d";
  return "cur";
}

async function grokLimits() {
  const cached = fresh("grok");
  if (cached !== undefined) return cached;
  const disk = diskFresh("grok");
  if (disk !== undefined) return disk;
  if (!shouldAttempt("grok")) return remember("grok", bestFallback("grok", null));
  markAttempt("grok");
  const billing = await grokBillingViaAcp();
  const cfg = billing && billing.config;
  if (!cfg || typeof cfg.creditUsagePercent !== "number") return remember("grok", bestFallback("grok", null));
  const period = cfg.currentPeriod || {};
  const windows = [
    {
      label: grokPeriodLabel(period.type),
      pct: cfg.creditUsagePercent,
      resetsAt: period.end ? Date.parse(period.end) : cfg.billingPeriodEnd ? Date.parse(cfg.billingPeriodEnd) : 0,
    },
  ];
  return remember("grok", { windows, asOfMs: Date.now(), live: true });
}
// ---------------------------------------------------------------- agy

// Run the Antigravity CLI's /usage command in print mode. It runs in the temp
// directory so it never treats the plugin folder as a workspace.
function agyUsageViaCli() {
  return new Promise((resolve) => {
    try {
      execFile(
        "agy",
        ["-p", "/usage", "--output-format", "json"],
        { cwd: os.tmpdir(), timeout: 20_000, maxBuffer: 1 << 20, encoding: "utf8" },
        (err, stdout) => {
          if (err) return resolve(null);
          const text = String(stdout || "");
          const start = text.indexOf("{");
          const end = text.lastIndexOf("}");
          if (start < 0 || end < start) return resolve(null);
          try {
            resolve(JSON.parse(text.slice(start, end + 1)));
          } catch {
            resolve(null);
          }
        },
      );
    } catch {
      resolve(null);
    }
  });
}

// The Gemini group (Neon, Hydrogen, Flash, Orchestrator) is the primary one:
// its windows are labeled plainly ("5h", "wk"). Other groups get a short
// prefix ("C/G wk", "Argon wk") and `extra: true`, so compact views can show
// only the busiest of them (see summaryWindows).
function agyGroupPrefix(group, buckets) {
  const ids = buckets.map((b) => String((b && b.id) || "").toLowerCase());
  const name = String((group && group.name) || "");
  if (ids.some((id) => id.startsWith("3p-")) || /claude|gpt/i.test(name)) return "C/G";
  if (ids.some((id) => id.includes("argon")) || /argon/i.test(name)) return "Argon";
  return compactLimitLabel(name.split(/\s+/).slice(0, 1).join(" "), "grp").slice(0, 6);
}

function agyWindows(data) {
  const groups = data && data.command && data.command.data && data.command.data.groups;
  if (!Array.isArray(groups)) return [];
  const isPrimary = (g, buckets) =>
    /^gemini models?$/i.test(String((g && g.name) || "").trim()) ||
    buckets.some((b) => /^gemini-(weekly|5h)$/i.test(String((b && b.id) || "")));
  // Without a recognizable Gemini group every group keeps its prefix, so no
  // other group's limit is shown as the plain Gemini 5h/wk.
  const primary = groups.findIndex((g) => isPrimary(g, Array.isArray(g && g.buckets) ? g.buckets : []));
  // Within a group, 5h comes before wk, like the other vendors' rows.
  const rank = (win) => (win === "5h" ? 0 : win === "wk" ? 1 : 2);
  const windows = [];
  // The primary group's windows come first in every view.
  const order = groups.map((g, gi) => gi);
  if (primary > 0) order.unshift(...order.splice(primary, 1));
  order.forEach((gi) => {
    const g = groups[gi];
    const buckets = Array.isArray(g && g.buckets) ? g.buckets : [];
    const prefix = gi === primary ? "" : agyGroupPrefix(g, buckets);
    const own = [];
    for (const b of buckets) {
      if (!b || typeof b.remaining_fraction !== "number" || !Number.isFinite(b.remaining_fraction)) continue;
      const win = b.window === "weekly" ? "wk" : compactLimitLabel(b.window, "cur");
      const used = Math.max(0, Math.min(100, (1 - b.remaining_fraction) * 100));
      const w = { label: prefix ? `${prefix} ${win}` : win, pct: used, resetsAt: resetEpoch(b.reset_time) };
      if (prefix) w.extra = true;
      own.push({ rank: rank(win), w });
    }
    own.sort((a, b) => a.rank - b.rank);
    for (const { w } of own) windows.push(w);
  });
  return windows;
}

async function agyLimits() {
  const cached = fresh("agy");
  if (cached !== undefined) return cached;
  const disk = diskFresh("agy");
  if (disk !== undefined) return disk;
  if (!shouldAttempt("agy")) return remember("agy", bestFallback("agy", null));
  markAttempt("agy");
  const data = await agyUsageViaCli();
  const windows = data && data.status === "SUCCESS" ? agyWindows(data) : [];
  if (windows.length === 0) return remember("agy", bestFallback("agy", null));
  return remember("agy", { windows, asOfMs: Date.now(), live: true });
}

// ---------------------------------------------------------------- main

// The windows a compact view (sidebar row, one-line summary) shows: every
// primary window, plus the busiest `extra` one when anything has been used of
// it. Vendors without extra windows are unchanged.
function summaryWindows(snap) {
  if (!snap || !Array.isArray(snap.windows)) return [];
  const now = Date.now();
  const main = snap.windows.filter((w) => !w.extra);
  let busiest = null;
  for (const w of snap.windows) {
    if (!w.extra || (w.resetsAt && w.resetsAt < now) || !(w.pct > 0)) continue;
    if (!busiest || w.pct > busiest.pct) busiest = w;
  }
  return busiest ? main.concat([busiest]) : main;
}

// Returns { claude, codex, grok, agy } where each is
//   { windows: [{label, pct, resetsAt(ms), extra?}], asOfMs, live? } or null.
async function collectLimits() {
  const [claude, codex, grok, agy] = await Promise.all([claudeLimits(), codexLimits(), grokLimits(), agyLimits()]);
  return { claude, codex, grok, agy };
}

module.exports = { collectLimits, summaryWindows, agyWindows };
