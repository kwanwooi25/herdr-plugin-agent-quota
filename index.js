#!/usr/bin/env node
// Agent Usage dashboard: token & cost usage for Claude Code, Codex, and Grok.
//
// Interactive TUI when run in a Herdr popup pane (or any TTY).
// `node index.js --report [--days N]` prints a plain-text report and exits.
"use strict";

const { collectUsage } = require("./lib/collect");

const AGENTS = ["claude", "codex", "grok"];
const AGENT_LABEL = { claude: "Claude Code", codex: "Codex", grok: "Grok" };
const AGENT_SHORT = { claude: "CC", codex: "CDX", grok: "GRX" };
const AGENT_COLOR = { claude: 208, codex: 75, grok: 250 };

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || null;
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || null;

// ---------------------------------------------------------------- formatting

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const fg = (n, s) => (useColor ? `\x1b[38;5;${n}m${s}\x1b[0m` : String(s));

function fmtTok(n) {
  if (n === 0) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function fmtCost(t) {
  if (!t || !t.costKnown) return "-";
  return "$" + t.cost.toFixed(2);
}

function pad(s, w, right = false) {
  s = String(s);
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  const fill = Math.max(0, w - visible.length);
  return right ? " ".repeat(fill) + s : s + " ".repeat(fill);
}
function clip(line, cols) {
    // ANSI-aware truncation: count visible chars, keep escape codes intact.
    let visible = 0;
    let i = 0;
    while (i < line.length && visible < cols) {
      if (line[i] === "\x1b") {
        const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
        i += m ? m[0].length : 1;
        continue;
      }
      visible++;
      i++;
    }
    return visible >= cols ? line.slice(0, i) + "\x1b[0m" : line;
}

function lastDates(n) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(d.toLocaleDateString("en-CA"));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

// ---------------------------------------------------------------- rendering

function sumTotals(days, dates) {
  const totals = {};
  for (const a of AGENTS) totals[a] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false };
  for (const date of dates) {
    const byAgent = days.get(date);
    if (!byAgent) continue;
    for (const a of AGENTS) {
      const t = byAgent.get(a);
      if (!t) continue;
      totals[a].input += t.input;
      totals[a].output += t.output;
      totals[a].cacheRead += t.cacheRead;
      totals[a].cacheWrite += t.cacheWrite;
      if (t.costKnown) {
        totals[a].cost += t.cost;
        totals[a].costKnown = true;
      }
    }
  }
  return totals;
}

function render(data, opts) {
  const { days: periodDays, showModels, refreshedAt, interactive } = opts;
  const dates = lastDates(periodDays);
  const totals = sumTotals(data.days, dates);
  const lines = [];

  lines.push(
    bold(" Agent Usage ") +
      dim(`Claude Code / Codex / Grok   ${refreshedAt}`),
  );
  if (interactive) {
    lines.push(
      dim(" period ") + bold(`${periodDays}d`) +
        dim("   [1] 7d  [2] 14d  [3] 30d   [m] models   [r] refresh   [q] quit"),
    );
  }
  lines.push("");

  // Totals
  lines.push(bold(` TOTALS`) + dim(` last ${periodDays} days`));
  const th = ["agent", "input", "output", "cache-read", "cache-write", "cost"];
  const w = [13, 10, 10, 12, 12, 10];
  lines.push(dim(" " + th.map((h, i) => pad(h, w[i], i > 0)).join(" ")));
  const all = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false };
  for (const a of AGENTS) {
    const t = totals[a];
    all.input += t.input;
    all.output += t.output;
    all.cacheRead += t.cacheRead;
    all.cacheWrite += t.cacheWrite;
    if (t.costKnown) {
      all.cost += t.cost;
      all.costKnown = true;
    }
    const empty = t.input + t.output + t.cacheRead + t.cacheWrite === 0;
    const row =
      " " +
      pad(fg(AGENT_COLOR[a], AGENT_LABEL[a]), w[0]) +
      " " +
      (empty
        ? dim(pad("no data", w[1], true))
        : [t.input, t.output, t.cacheRead, t.cacheWrite]
            .map((v, i) => pad(fmtTok(v), w[i + 1], true))
            .join(" ") +
          " " +
          pad(fmtCost(t), w[5], true));
    lines.push(row);
  }
  lines.push(
    " " +
      pad(bold("all"), w[0]) +
      " " +
      [all.input, all.output, all.cacheRead, all.cacheWrite]
        .map((v, i) => pad(bold(fmtTok(v)), w[i + 1], true))
        .join(" ") +
      " " +
      pad(bold(fmtCost(all)), w[5], true),
  );
  lines.push("");

  // Daily table. "tok" = input + output (cache excluded); cost includes cache.
  lines.push(bold(" DAILY") + dim("  tok = input+output, cost includes cache"));
  const dh = ["date", "claude", "", "codex", "", "grok", "", "total"];
  const dw = [11, 8, 8, 8, 8, 8, 8, 9];
  lines.push(
    dim(
      " " +
        pad("date", dw[0]) +
        [1, 3, 5].map((i) => pad(dh[i] + " tok", dw[i], true) + " " + pad("cost", dw[i + 1], true)).join(" ") +
        " " +
        pad("total", dw[7], true),
    ),
  );
  for (const date of dates) {
    const byAgent = data.days.get(date) || new Map();
    let anything = false;
    let totalTok = 0;
    const cells = [];
    for (const a of AGENTS) {
      const t = byAgent.get(a);
      const tok = t ? t.input + t.output : 0;
      totalTok += tok;
      if (t) anything = true;
      cells.push(pad(t ? fg(AGENT_COLOR[a], fmtTok(tok)) : dim("-"), 8, true) + " " + pad(t ? fmtCost(t) : dim("-"), 8, true));
    }
    if (!anything && date !== dates[0]) {
      lines.push(" " + pad(dim(date), dw[0]) + cells.map(() => pad(dim("-"), 8, true) + " " + pad(dim("-"), 8, true)).join(" ") + " " + pad(dim("-"), dw[7], true));
      continue;
    }
    lines.push(" " + pad(date, dw[0]) + cells.join(" ") + " " + pad(bold(fmtTok(totalTok)), dw[7], true));
  }

  // Model breakdown
  if (showModels) {
    lines.push("");
    lines.push(bold(" MODELS") + dim("  all scanned history, top 10 by cost"));
    lines.push(dim(" " + pad("model", 34) + pad("input", 10, true) + " " + pad("output", 10, true) + " " + pad("cache-read", 12, true) + " " + pad("cost", 10, true)));
    const rows = [...data.models.entries()].sort((x, y) => (y[1].costKnown ? y[1].cost : 0) - (x[1].costKnown ? x[1].cost : 0)).slice(0, 10);
    for (const [name, t] of rows) {
      const agent = name.split(" ")[0];
      lines.push(
        " " +
          pad(fg(AGENT_COLOR[agent] || 255, name), 34) +
          pad(fmtTok(t.input), 10, true) +
          " " +
          pad(fmtTok(t.output), 10, true) +
          " " +
          pad(fmtTok(t.cacheRead), 12, true) +
          " " +
          pad(fmtCost(t), 10, true),
      );
    }
  }

  if (data.errors.length) {
    lines.push("");
    lines.push(dim(` ${data.errors.length} file(s) failed to parse; run with --report to list them`));
  }
  if (data.pricingFile) {
    lines.push("");
    lines.push(dim(` Claude/Codex costs are estimates from ${data.pricingFile}; Grok costs are actuals`));
  }
  return lines;
}

// ---------------------------------------------------------------- modes

function now() {
  return new Date().toLocaleString("en-CA", { hour12: false });
}

async function reportMode(periodDays) {
  const data = await collectUsage({ stateDir, configDir });
  const lines = render(data, { days: periodDays, showModels: true, refreshedAt: now(), interactive: false });
  process.stdout.write(lines.join("\n") + "\n");
  const strip = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  for (const e of data.errors) process.stderr.write(`parse error [${e.agent}] ${strip(e.file)}: ${strip(e.error)}\n`);
}

async function interactiveMode(periodDays) {
  let opts = { days: periodDays, showModels: true, refreshedAt: "loading...", interactive: true };
  let data = { days: new Map(), models: new Map(), errors: [], pricingFile: null };

  const out = process.stdout;
  out.write("\x1b[?1049h\x1b[?25l"); // alt screen, hide cursor
  const restore = () => out.write("\x1b[?25h\x1b[?1049l");
  const draw = () => {
    const rows = out.rows || 40;
    const cols = out.columns || 120;
    const lines = render(data, opts)
      .slice(0, rows - 1)
      .map((l) => clip(l, cols));
    out.write("\x1b[H\x1b[2J" + lines.join("\x1b[K\r\n") + "\x1b[K");
  };
  const fail = (e) => {
    restore();
    process.stderr.write(String(e.stack || e) + "\n");
    process.exit(1);
  };
  let scanning = false;
  const refresh = async () => {
    if (scanning) return;
    scanning = true;
    opts.refreshedAt = "scanning...";
    draw();
    try {
      data = await collectUsage({ stateDir, configDir });
    } finally {
      scanning = false;
    }
    opts.refreshedAt = now();
    draw();
  };

  const quit = () => {
    restore();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  out.on("resize", draw);

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    // A chunk may contain several keys (fast typing, paste); handle each.
    // A lone Esc quits; an escape sequence (arrows, F-keys) is ignored.
    for (const key of chunk) {
      if (key === "\x1b") {
        if (chunk.length === 1) return quit();
        break;
      }
      if (key === "q" || key === "\x03") return quit();
      if (key === "r") {
        refresh().catch(fail);
        continue;
      }
      if (key === "m") opts.showModels = !opts.showModels;
      else if (key === "1") opts.days = 7;
      else if (key === "2") opts.days = 14;
      else if (key === "3") opts.days = 30;
      else continue;
      draw();
    }
  });

  await refresh().catch(fail);
}

// Compact always-on rate-limit view for a short pane docked under a sidebar
// column: per agent, time until the window resets plus a gauge per limit
// window. Refreshes automatically once a minute.
function fmtEta(ms) {
  let s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtAge(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function gauge(pct, width) {
  const p = Math.max(0, Math.min(100, pct));
  const color = p >= 80 ? 196 : p >= 50 ? 178 : 70; // red / yellow / green
  const filled = Math.max(p > 0 ? 1 : 0, Math.round((p / 100) * width));
  const bar = fg(color, "\u2501".repeat(filled)) + dim("\u2501".repeat(width - filled));
  return `${bar} ${fg(color, pad(Math.round(p) + "%", 3, true))}`;
}

async function statusbarMode() {
  const { collectLimits } = require("./lib/limits");
  let limits = { claude: null, codex: null, grok: null };

  const out = process.stdout;
  out.write("\x1b[?1049h\x1b[?25l");
  const restore = () => out.write("\x1b[?25h\x1b[?1049l");

  const draw = () => {
    const cols = out.columns || 44;
    const rows = out.rows || 8;
    const barW = cols >= 46 ? 6 : 4;
    const lines = [];
    for (const a of AGENTS) {
      const snap = limits[a];
      const name = fg(AGENT_COLOR[a], bold(AGENT_LABEL[a]));
      if (!snap || snap.windows.length === 0) {
        lines.push(` ${name}  ${dim(a === "grok" ? "quota not exposed" : "no data")}`);
        continue;
      }
      const future = snap.windows.filter((w) => w.resetsAt > Date.now());
      const next = future.length ? Math.min(...future.map((w) => w.resetsAt)) : null;
      const stale = Date.now() - snap.asOfMs > 6 * 3600_000;
      let head = ` ${name}  `;
      head += next ? dim(`resets in ${fmtEta(next)}`) : dim("window elapsed");
      if (stale) head += dim(` \u00b7 ${fmtAge(snap.asOfMs)} ago`);
      lines.push(head);
      const cells = snap.windows.map((w) =>
        w.resetsAt && w.resetsAt < Date.now()
          ? `${dim(pad(w.label, 2))} ${dim("\u2500".repeat(barW))} ${dim(" -%")}`
          : `${dim(pad(w.label, 2))} ${gauge(w.pct, barW)}`,
      );
      lines.push("   " + cells.join("  "));
    }
    out.write(
      "\x1b[H\x1b[2J" +
        lines
          .slice(0, rows)
          .map((l) => clip(l, cols))
          .join("\x1b[K\r\n") +
        "\x1b[K",
    );
  };
  const fail = (e) => {
    restore();
    process.stderr.write(String(e.stack || e) + "\n");
    process.exit(1);
  };
  let scanning = false;
  const refresh = async () => {
    if (scanning) return;
    scanning = true;
    try {
      limits = await collectLimits();
    } finally {
      scanning = false;
    }
    draw();
  };

  const quit = () => {
    restore();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  out.on("resize", draw);
  const timer = setInterval(() => refresh().catch(fail), 60_000);
  timer.unref();

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      for (const key of chunk) {
        if (key === "\x1b") {
          if (chunk.length === 1) return quit();
          break;
        }
        if (key === "q" || key === "\x03") return quit();
        if (key === "r") refresh().catch(fail);
      }
    });
  }

  draw();
  await refresh().catch(fail);
}

// ---------------------------------------------------------------- entry

const argv = process.argv.slice(2);
const daysArg = argv.indexOf("--days");
const periodDays = daysArg >= 0 ? Math.max(1, parseInt(argv[daysArg + 1], 10) || 14) : 14;

const entrypoint = process.env.HERDR_PLUGIN_ENTRYPOINT_ID || "";

if (argv.includes("--limits")) {
  const { collectLimits } = require("./lib/limits");
  collectLimits().then(
    (l) => process.stdout.write(JSON.stringify(l, null, 2) + "\n"),
    (e) => {
      process.stderr.write(String(e.stack || e) + "\n");
      process.exit(1);
    },
  );
} else if (argv.includes("--oneline")) {
  // One-line plain-text summary for a `ui.tab_bar_right` command entry.
  // Honors the same sidebar.toml display mode (used | remaining).
  const { collectLimits } = require("./lib/limits");
  const display = require("./lib/config").loadSidebarConfig(configDir).display;
  collectLimits().then(
    (l) => {
      const parts = [];
      for (const a of AGENTS) {
        const snap = l[a];
        if (!snap || snap.windows.length === 0) continue;
        const live = snap.windows.filter((w) => !(w.resetsAt && w.resetsAt < Date.now()));
        if (live.length === 0) continue;
        const cell = (w) => {
          const used = Math.max(0, Math.min(100, w.pct));
          return `${w.label} ${Math.round(display === "remaining" ? 100 - used : used)}%`;
        };
        parts.push(`${AGENT_SHORT[a]} ` + live.map(cell).join(" "));
      }
      process.stdout.write((parts.length ? parts.join(" \u00b7 ") : "") + "\n");
    },
    (e) => {
      process.stderr.write(String(e.stack || e) + "\n");
      process.exit(1);
    },
  );
} else if (argv.includes("--statusbar") || entrypoint === "statusbar") {
  statusbarMode().catch((e) => {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    process.stderr.write(String(e.stack || e) + "\n");
    process.exit(1);
  });
} else if (argv.includes("--report") || !process.stdout.isTTY) {
  reportMode(periodDays).catch((e) => {
    process.stderr.write(String(e.stack || e) + "\n");
    process.exit(1);
  });
} else {
  interactiveMode(periodDays).catch((e) => {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    process.stderr.write(String(e.stack || e) + "\n");
    process.exit(1);
  });
}
