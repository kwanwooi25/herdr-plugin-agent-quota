// Usage collectors for Claude Code, Codex, and Grok session logs.
//
// Each collector scans local session files and yields per-file "entries":
//   [dedupeKey|null, date(YYYY-MM-DD local), model, input, output, cacheRead, cacheWrite, costUSD|null]
// Per-file results are cached in HERDR_PLUGIN_STATE_DIR keyed by mtime+size,
// so only new or changed files are re-parsed on refresh.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");

const CACHE_VERSION = 2;
// ---------------------------------------------------------------- helpers

function home(env, fallback) {
  const v = process.env[env];
  return v && v.trim() ? v : path.join(os.homedir(), fallback);
}

function localDate(msOrIso) {
  const d = typeof msOrIso === "number" ? new Date(msOrIso) : new Date(String(msOrIso));
  if (Number.isNaN(d.getTime())) return null;
  // en-CA formats as YYYY-MM-DD in the local timezone.
  return d.toLocaleDateString("en-CA");
}

// Log-derived strings are rendered to the terminal; strip control characters
// so a crafted model name cannot inject escape sequences.
function clean(s) {
  return String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function listFiles(dir, filter, out = []) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of names) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listFiles(p, filter, out);
    else if (ent.isFile() && filter(p)) out.push(p);
  }
  return out;
}

async function eachJsonLine(file, fn) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // tolerate truncated trailing lines from live sessions
    }
    if (!obj || typeof obj !== "object") continue;
    fn(obj);
  }
}

// ---------------------------------------------------------------- pricing

const DEFAULT_PRICING = [
  { match: "opus", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: "sonnet", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: "haiku", input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  { match: "gpt-5", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  { match: "codex", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  { match: "gpt-4", input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  { match: "grok", input: 3, output: 15, cacheRead: 0.75, cacheWrite: 0 },
];

function pricingTemplate(rules) {
  const blocks = rules
    .map((r) =>
      [
        "[[rule]]",
        `match = "${r.match}"`,
        `input = ${r.input}`,
        `output = ${r.output}`,
        `cacheRead = ${r.cacheRead}`,
        `cacheWrite = ${r.cacheWrite}`,
      ].join("\n"),
    )
    .join("\n\n");
  return `# Agent Quota — cost estimation rules for Claude Code and Codex.
# (Grok costs are actuals recorded by the Grok CLI and never estimated.)
#
# All values are USD per million tokens. Rules match by case-insensitive
# substring on the model name; the first matching rule wins. Models matching
# no rule are counted in token totals but excluded from cost.

${blocks}
`;
}

function validRules(rules) {
  return Array.isArray(rules) && rules.every((r) => r && typeof r.match === "string");
}

function loadPricing(configDir) {
  const file = configDir ? path.join(configDir, "pricing.toml") : null;
  if (file) {
    try {
      if (fs.existsSync(file)) {
        const rules = require("./toml").parse(fs.readFileSync(file, "utf8")).rule;
        if (validRules(rules)) return { rules, file };
      } else {
        // Seed pricing.toml, migrating a legacy pricing.json when present.
        let rules = DEFAULT_PRICING;
        const legacy = path.join(configDir, "pricing.json");
        try {
          const parsed = JSON.parse(fs.readFileSync(legacy, "utf8"));
          if (validRules(parsed)) rules = parsed;
        } catch {}
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(file, pricingTemplate(rules));
        fs.rmSync(legacy, { force: true });
        return { rules, file };
      }
    } catch {
      // unreadable/corrupt pricing file: fall back to defaults
    }
  }
  return { rules: DEFAULT_PRICING, file };
}

function priceFor(rules, model) {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const r of rules) {
    if (r && typeof r.match === "string" && m.includes(r.match.toLowerCase())) return r;
  }
  return null;
}

function estimateCost(rules, model, input, output, cacheRead, cacheWrite) {
  const p = priceFor(rules, model);
  if (!p) return null;
  return (
    (input * (p.input || 0) +
      output * (p.output || 0) +
      cacheRead * (p.cacheRead || 0) +
      cacheWrite * (p.cacheWrite || 0)) /
    1e6
  );
}

// ---------------------------------------------------------------- collectors

// Claude Code: ~/.claude/projects/<project>/<session>.jsonl
async function parseClaudeFile(file) {
  const entries = [];
  await eachJsonLine(file, (o) => {
    if (o.type !== "assistant") return;
    const msg = o.message;
    if (!msg || typeof msg !== "object") return;
    const u = msg.usage;
    if (!u || typeof u !== "object") return;
    const date = localDate(o.timestamp);
    if (!date) return;
    const key = msg.id ? `${msg.id}:${o.requestId ?? ""}` : null;
    entries.push([
      key,
      date,
      msg.model ? clean(msg.model) : "unknown",
      u.input_tokens || 0,
      u.output_tokens || 0,
      u.cache_read_input_tokens || 0,
      u.cache_creation_input_tokens || 0,
      null,
    ]);
  });
  return entries;
}

// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
async function parseCodexFile(file) {
  const entries = [];
  let model = "unknown";
  await eachJsonLine(file, (o) => {
    if (o.type === "turn_context" && o.payload && o.payload.model) {
      model = clean(o.payload.model);
      return;
    }
    if (o.type !== "event_msg") return;
    const p = o.payload;
    if (!p || p.type !== "token_count") return;
    const last = p.info && p.info.last_token_usage;
    if (!last) return;
    const date = localDate(o.timestamp);
    if (!date) return;
    entries.push([
      null,
      date,
      model,
      // cached_input_tokens is a subset of input_tokens in Codex rollouts;
      // split them so cached tokens are not double-priced.
      Math.max(0, (last.input_tokens || 0) - (last.cached_input_tokens || 0)),
      last.output_tokens || 0,
      last.cached_input_tokens || 0,
      last.cache_write_input_tokens || 0,
      null,
    ]);
  });
  return entries;
}

// Grok: ~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl
async function parseGrokFile(file) {
  const entries = [];
  await eachJsonLine(file, (o) => {
    const update = o.params && o.params.update;
    if (!update || update.sessionUpdate !== "turn_completed") return;
    const u = update.usage;
    if (!u || typeof u !== "object") return;
    const date = localDate((o.timestamp || 0) * 1000);
    if (!date) return;
    const turnCost = typeof u.costUsdTicks === "number" ? u.costUsdTicks / 1e10 : null;
    const models = u.modelUsage && typeof u.modelUsage === "object" ? Object.entries(u.modelUsage) : [];
    if (models.length === 0) {
      entries.push([
        null,
        date,
        "unknown",
        // Grok inputTokens include cached reads; split like Codex.
        Math.max(0, (u.inputTokens || 0) - (u.cachedReadTokens || 0)),
        u.outputTokens || 0,
        u.cachedReadTokens || 0,
        u.cacheCreationTokens || 0,
        turnCost,
      ]);
      return;
    }
    models.forEach(([rawModel, mu], i) => {
      const model = clean(rawModel);
      if (mu === null || typeof mu !== "object") return;
      let cost = null;
      if (typeof mu.costUsdTicks === "number") cost = mu.costUsdTicks / 1e10;
      else if (typeof mu.costUSD === "number") cost = mu.costUSD;
      else if (i === 0) cost = turnCost; // attribute unsplit turn cost to the primary model
      entries.push([
        null,
        date,
        model,
        Math.max(0, (mu.inputTokens || 0) - (mu.cachedReadTokens || 0)),
        mu.outputTokens || 0,
        mu.cachedReadTokens || 0,
        mu.cacheCreationTokens || 0,
        cost,
      ]);
    });
  });
  return entries;
}

const SOURCES = [
  {
    agent: "claude",
    files() {
      const root = path.join(home("CLAUDE_CONFIG_DIR", ".claude"), "projects");
      return listFiles(root, (p) => p.endsWith(".jsonl"));
    },
    parse: parseClaudeFile,
  },
  {
    agent: "codex",
    files() {
      const root = path.join(home("CODEX_HOME", ".codex"), "sessions");
      return listFiles(root, (p) => path.basename(p).startsWith("rollout-") && p.endsWith(".jsonl"));
    },
    parse: parseCodexFile,
  },
  {
    agent: "grok",
    files() {
      const root = path.join(home("GROK_HOME", ".grok"), "sessions");
      return listFiles(root, (p) => path.basename(p) === "updates.jsonl");
    },
    parse: parseGrokFile,
  },
];

// ---------------------------------------------------------------- cache

function cachePath(stateDir) {
  return path.join(stateDir, `usage-cache-v${CACHE_VERSION}.json`);
}

function loadCache(stateDir) {
  if (!stateDir) return { files: {} };
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(stateDir), "utf8"));
    if (c && c.version === CACHE_VERSION && c.files) {
      // Drop records whose entries are not tuple arrays (corrupt/tampered cache)
      for (const [file, rec] of Object.entries(c.files)) {
        if (!rec || !Array.isArray(rec.entries) || !rec.entries.every(Array.isArray)) delete c.files[file];
      }
      return c;
    }
  } catch {
    // first run or corrupt cache
  }
  return { files: {} };
}

function saveCache(stateDir, cache) {
  if (!stateDir) return;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = cachePath(stateDir) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, files: cache.files }));
    fs.renameSync(tmp, cachePath(stateDir));
    // Prune caches from older schema versions.
    for (const name of fs.readdirSync(stateDir)) {
      if (/^usage-cache-v\d+\.json$/.test(name) && name !== `usage-cache-v${CACHE_VERSION}.json`) {
        fs.unlinkSync(path.join(stateDir, name));
      }
    }
  } catch {
    // cache is an optimization only; never fail collection over it
  }
}

// ---------------------------------------------------------------- main

// Returns:
//   days:   Map date -> Map agent -> {input, output, cacheRead, cacheWrite, cost}
//   models: Map `${agent} ${model}` -> same shape (all-time within scanned files)
//   errors: [{agent, file, error}]
async function collectUsage({ stateDir, configDir } = {}) {
  const pricing = loadPricing(configDir);
  const cache = loadCache(stateDir);
  const nextFiles = {};
  const perFile = []; // {agent, file, mtimeMs, entries}
  const errors = [];

  for (const src of SOURCES) {
    for (const file of src.files()) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const sig = `${st.mtimeMs}:${st.size}`;
      const cached = cache.files[file];
      if (cached && cached.sig === sig && cached.agent === src.agent) {
        nextFiles[file] = cached;
        perFile.push({ agent: src.agent, file, mtimeMs: st.mtimeMs, entries: cached.entries });
        continue;
      }
      try {
        const entries = await src.parse(file);
        const rec = { agent: src.agent, sig, entries };
        nextFiles[file] = rec;
        perFile.push({ agent: src.agent, file, mtimeMs: st.mtimeMs, entries });
      } catch (e) {
        errors.push({ agent: src.agent, file, error: e.message });
      }
    }
  }

  cache.files = nextFiles;
  saveCache(stateDir, cache);

  // Oldest file first so a duplicated message is attributed to its origin.
  perFile.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const days = new Map();
  const models = new Map();
  const seen = new Set();

  for (const { agent, entries } of perFile) {
    for (const [key, date, model, input, output, cacheRead, cacheWrite, actualCost] of entries) {
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      // Grok costs are actuals only; never estimate them from pricing rules.
      const cost =
        actualCost !== null && actualCost !== undefined
          ? actualCost
          : agent === "grok"
            ? null
            : estimateCost(pricing.rules, model, input, output, cacheRead, cacheWrite);

      let byAgent = days.get(date);
      if (!byAgent) days.set(date, (byAgent = new Map()));
      add(byAgent, agent, input, output, cacheRead, cacheWrite, cost);
      add(models, `${agent} ${model}`, input, output, cacheRead, cacheWrite, cost);
    }
  }

  return { days, models, errors, pricingFile: pricing.file };
}

function add(map, key, input, output, cacheRead, cacheWrite, cost) {
  let t = map.get(key);
  if (!t) map.set(key, (t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false }));
  t.input += input;
  t.output += output;
  t.cacheRead += cacheRead;
  t.cacheWrite += cacheWrite;
  if (cost !== null && cost !== undefined) {
    t.cost += cost;
    t.costKnown = true;
  }
}

module.exports = { collectUsage, DEFAULT_PRICING };
