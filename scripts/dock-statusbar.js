// Toggle a compact usage statusbar pane docked at the bottom of the leftmost
// pane column in the current tab (statusbar-style, under a sidebar pane when
// one is docked left).
//
// Toggle semantics: if this plugin's statusbar pane is already open in the
// current tab, close it; otherwise split the bottom-left pane down, open the
// `statusbar` entrypoint there without stealing focus, and shrink it to a few
// rows.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const pluginId = process.env.HERDR_PLUGIN_ID ?? "kwanwooi25.agent-quota";
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || null;

const BAR_ROWS = 5; // header + three agent rows + breathing room

function run(args) {
  const r = spawnSync(herdr, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new Error(`${herdr}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`herdr ${args.join(" ")}: ${(r.stderr || r.stdout || "").trim()}`);
  return JSON.parse(r.stdout);
}

function focusedPaneId() {
  const ctx = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (ctx) {
    try {
      const c = JSON.parse(ctx);
      const id = c.focused_pane_id || (c.focused_pane && c.focused_pane.pane_id) || (c.pane && c.pane.pane_id);
      if (id) return id;
    } catch {
      // fall through to env
    }
  }
  return process.env.HERDR_PANE_ID || null;
}

function statePath() {
  return stateDir ? path.join(stateDir, "statusbar-panes.json") : null;
}

function loadState() {
  const p = statePath();
  if (!p) return {};
  try {
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

function saveState(state) {
  const p = statePath();
  if (!p) return;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state));
  } catch {
    // state is a convenience for toggling; opening still works without it
  }
}

function main() {
  const anchor = focusedPaneId();
  if (!anchor) throw new Error("no pane context; invoke from inside a Herdr tab");

  const layout = run(["pane", "layout", "--pane", anchor]).result.layout;
  const tabId = layout.tab_id;
  const paneIds = new Set(layout.panes.map((p) => p.pane_id));

  // Toggle off when our statusbar pane from a previous invocation is alive.
  const state = loadState();
  const existing = state[tabId];
  if (existing && paneIds.has(existing)) {
    try {
      run(["plugin", "pane", "close", existing]);
    } catch {
      // Ownership can be lost when the plugin is relinked while the pane is
      // running; close it as a plain pane instead.
      run(["pane", "close", existing]);
    }
    delete state[tabId];
    saveState(state);
    process.stdout.write(`closed ${existing}\n`);
    return;
  }

  // Bottom pane of the leftmost column.
  const minX = Math.min(...layout.panes.map((p) => p.rect.x));
  const column = layout.panes.filter((p) => p.rect.x === minX);
  const target = column.reduce((a, b) => (b.rect.y > a.rect.y ? b : a));

  const opened = run([
    "plugin", "pane", "open",
    "--plugin", pluginId,
    "--entrypoint", "statusbar",
    "--placement", "split",
    "--target-pane", target.pane_id,
    "--direction", "down",
    "--no-focus",
  ]).result.plugin_pane.pane;

  // The split is 50/50; shrink the bar to BAR_ROWS. --amount is a fraction of
  // the tab area height, and --direction down on the bottom pane shrinks it.
  const after = run(["pane", "layout", "--pane", opened.pane_id]).result.layout;
  const bar = after.panes.find((p) => p.pane_id === opened.pane_id);
  const areaH = after.area.height;
  if (bar && areaH > 0 && bar.rect.height > BAR_ROWS + 1) {
    const amount = (bar.rect.height - (BAR_ROWS + 1)) / areaH;
    run(["pane", "resize", "--pane", opened.pane_id, "--direction", "down", "--amount", String(amount)]);
  }

  state[tabId] = opened.pane_id;
  saveState(state);
  process.stdout.write(`opened ${opened.pane_id}\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(String(e.message || e) + "\n");
  process.exit(1);
}
