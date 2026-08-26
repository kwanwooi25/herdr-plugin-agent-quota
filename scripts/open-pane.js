// Opens the dashboard popup pane. Bound to the plugin action "open" so users
// can attach it to a keybinding:
//
//   [[keys.command]]
//   key = "prefix+u"
//   type = "plugin_action"
//   command = "kwanwooi25.agent-quota.open"
"use strict";
const { spawnSync } = require("node:child_process");

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const pluginId = process.env.HERDR_PLUGIN_ID ?? "kwanwooi25.agent-quota";

const result = spawnSync(
  herdr,
  ["plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", "dashboard"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) process.stderr.write(`${herdr}: ${result.error.message}\n`);
process.exit(result.status ?? 1);
