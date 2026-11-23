// Plugin config files (TOML with comments) in HERDR_PLUGIN_CONFIG_DIR.
//
// sidebar.toml — display mode and agent-kind → vendor mapping for the sidebar
// reporter, status bar, and the `--oneline` tab bar output.
//
// Files are seeded with commented defaults on first use. Legacy JSON configs
// (sidebar.json) are migrated in place: values carried over, JSON removed.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const toml = require("./toml");

const DEFAULT_KIND_MAP = { claude: "claude", codex: "codex", grok: "grok", agy: "agy", omp: "claude" };

function sidebarTemplate(display, kindMap, showModel) {
  const mapLines = Object.entries(kindMap)
    .map(([k, v]) => `${k} = "${v}"`)
    .join("\n");
  return `# Agent Quota — display settings for the sidebar tokens, status bar,
# and \`--oneline\` tab bar output. Edited values apply on the next draw or
# refresh tick (within a minute); no restart needed.

# What the percentages and gauges show:
#   "used"      — consumed share of each quota window (gauges fill as you spend)
#   "remaining" — what is left (gauges drain as you spend)
# Severity colors always track consumption: <50% ok, <80% warn, >=80% bad.
display = "${display}"

# Show the model an omp pane is currently running (read from its session
# log) after the usage row, and route that pane's quota to the model's
# vendor instead of the static kindMap entry.
showModel = ${showModel}

# Which vendor's quota an agent kind displays in the sidebar.
# Keys are Herdr agent kinds (see \`herdr agent list\`); values are
# "claude", "codex", "grok", or "agy". Kinds without a mapping show nothing.
[kindMap]
${mapLines}
`;
}

// Returns { display: "used"|"remaining", showModel: bool, kindMap: {kind: vendor} }.
function loadSidebarConfig(configDir) {
  const cfg = { display: "used", showModel: true, kindMap: DEFAULT_KIND_MAP };
  if (!configDir) return cfg;
  const tomlFile = path.join(configDir, "sidebar.toml");
  const jsonFile = path.join(configDir, "sidebar.json");
  let raw = null;
  try {
    raw = toml.parse(fs.readFileSync(tomlFile, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") return cfg; // corrupt file: keep defaults, never crash
    // Seed sidebar.toml, migrating values from a legacy sidebar.json when present.
    let display = "used";
    let showModel = true;
    let kindMap = DEFAULT_KIND_MAP;
    try {
      const legacy = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
      if (legacy && legacy.display === "remaining") display = "remaining";
      if (legacy && typeof legacy.kindMap === "object") kindMap = { ...DEFAULT_KIND_MAP, ...legacy.kindMap };
    } catch {}
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(tomlFile, sidebarTemplate(display, kindMap, showModel));
      fs.rmSync(jsonFile, { force: true });
    } catch {}
    return { display, showModel, kindMap };
  }
  if (raw && raw.display === "remaining") cfg.display = "remaining";
  if (raw && raw.showModel === false) cfg.showModel = false;
  if (raw && typeof raw.kindMap === "object" && !Array.isArray(raw.kindMap)) {
    cfg.kindMap = { ...DEFAULT_KIND_MAP, ...raw.kindMap };
  }
  return cfg;
}

module.exports = { loadSidebarConfig, DEFAULT_KIND_MAP };
