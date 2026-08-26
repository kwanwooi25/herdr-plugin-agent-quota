// Minimal TOML subset parser for plugin config files. Zero dependencies.
//
// Supported: `#` comments, blank lines, bare or double-quoted keys, basic
// double-quoted strings (\" \\ \n \t escapes), integers, floats, booleans,
// single-level `[tables]`, and `[[arrays of tables]]`. That covers everything
// the plugin's own config files use; anything else raises with the offending
// line so a typo never silently drops settings.
"use strict";

function stripComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseValue(raw, lineNo) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^"/.test(raw)) {
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(raw);
    if (!m) throw new Error(`TOML line ${lineNo}: unterminated string`);
    return m[1].replace(/\\(["\\nt])/g, (_, c) => ({ '"': '"', "\\": "\\", n: "\n", t: "\t" }[c]));
  }
  if (/^[+-]?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(raw)) return parseFloat(raw);
  throw new Error(`TOML line ${lineNo}: unsupported value ${JSON.stringify(raw)}`);
}

function parse(src) {
  const root = {};
  let target = root;
  const lines = src.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = stripComment(lines[n]).trim();
    if (!line) continue;
    let m;
    if ((m = /^\[\[([^\]]+)\]\]$/.exec(line))) {
      const key = m[1].trim();
      if (!Array.isArray(root[key])) root[key] = [];
      target = {};
      root[key].push(target);
    } else if ((m = /^\[([^\]]+)\]$/.exec(line))) {
      const key = m[1].trim();
      if (typeof root[key] !== "object" || root[key] === null || Array.isArray(root[key])) root[key] = {};
      target = root[key];
    } else if ((m = /^(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_.-]+))\s*=\s*(.+)$/.exec(line))) {
      const key = m[1] !== undefined ? m[1].replace(/\\(["\\])/g, "$1") : m[2];
      target[key] = parseValue(m[3].trim(), n + 1);
    } else {
      throw new Error(`TOML line ${n + 1}: cannot parse ${JSON.stringify(lines[n].trim())}`);
    }
  }
  return root;
}

module.exports = { parse };
