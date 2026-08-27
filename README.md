# Agent Quota — Herdr plugin

Token and cost usage dashboard for **Claude Code**, **Codex**, and **Grok**,
rendered in a Herdr popup pane. Zero dependencies, no build step (Node ≥ 18).

## What it reads

| Agent | Source | Cost |
|---|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` (assistant `message.usage`) | estimated from `pricing.toml` |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` (`token_count` events) | estimated from `pricing.toml` |
| Grok | `~/.grok/sessions/**/updates.jsonl` (`turn_completed` usage) | **actual** (`costUsdTicks`) |

Everything is read locally; nothing leaves your machine. `CLAUDE_CONFIG_DIR`,
`CODEX_HOME`, and `GROK_HOME` are honored. Per-file aggregates are cached in
the plugin state dir (keyed by mtime+size), so refreshes only re-parse
changed files. Duplicated Claude messages from forked/resumed sessions are
deduplicated by `message.id` + `requestId`.

## Install

```bash
herdr plugin install kwanwooi25/herdr-plugin-agent-quota
```

Or link a local checkout while developing:

```bash
herdr plugin link /path/to/herdr-plugin-agent-quota
```

## Use

Open the dashboard popup:

```bash
herdr plugin pane open --plugin herdr-plugin-agent-quota --entrypoint dashboard
```

Or bind the action to a key in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+u"
type = "plugin_action"
command = "herdr-plugin-agent-quota.open"
description = "agent usage dashboard"
```

Keys inside the dashboard: `1`/`2`/`3` switch 7/14/30-day periods,
`m` toggles the per-model breakdown, `r` rescans, `q`/`Esc` quits.

### Statusbar

A compact always-on rate-limit bar docked at the bottom of the leftmost pane
column (under a sidebar pane such as herdr-sidebar when one is docked left).
Per agent it shows time until the limit window resets and a colored gauge per
window, refreshed once a minute. Gauge fill and percentage follow the
`sidebar.toml` `display` setting; severity colors always track consumption
(green under 50%, yellow under 80%, red from 80%):

```
 Claude Code  resets in 2d 3h
   5h ━━━───  32%  wk ━━━━──  70%
 Codex  resets in 6d 21h
   wk ━─────   3%
 Grok  no local data
```

Live sources are preferred — the same account endpoints the CLIs themselves
use — with local files as offline fallback (a dim `· 2h ago` marker appears
when falling back to data older than 6 hours):

- **Claude Code** — `api.anthropic.com/api/oauth/usage` with the Claude Code
  OAuth token (macOS Keychain `Claude Code-credentials`, or
  `~/.claude/.credentials.json`). Fallback: statusline payloads cached by the
  HUD under `~/.claude/hud/cache/stdin.*.json`.
- **Codex** — `chatgpt.com/backend-api/wham/usage` with the tokens in
  `~/.codex/auth.json`. Fallback: `rate_limits` on `token_count` events in
  recent rollout files.
- **Grok** — the `_x.ai/billing` ACP extension over a short-lived
  `grok agent stdio` process. The grok CLI authenticates with its own stored
  OAuth session (and refreshes tokens itself), so login state is untouched.
  No file fallback exists: the CLI records no quota data locally.

Privacy: tokens are read locally and sent only to their own vendor's API over
HTTPS; nothing is logged or written to disk. Live results are cached in
memory for 5 minutes.

An expired window (reset time already passed with no fresh sample) shows a
dim `-%` instead of a stale percentage. Toggle the bar per tab:

```bash
herdr plugin action invoke herdr-plugin-agent-quota.statusbar
```

```toml
[[keys.command]]
key = "prefix+shift+u"
type = "plugin_action"
command = "herdr-plugin-agent-quota.statusbar"
description = "toggle usage statusbar"
```

Inside the bar: `r` rescans, `q`/`Esc` closes.
`node index.js --limits` prints the same snapshot as JSON.

### Sidebar usage tokens

Renders each agent's quota as a colored text-gauge row directly inside the
Herdr sidebar, under the agent's own entry:

```
● tamche
  omp · claude-fable-5
  CC · 5h -% · wk ▰▰▰▱▱ 55%
```

A background reporter pushes pane-metadata tokens
(`herdr pane report-metadata`) to every live agent pane. Quota snapshots refresh
once a minute; omp session files are watched separately so model and vendor
changes reach the sidebar within about 250 ms. Tokens have a 5-minute TTL so
rows disappear if the reporter stops. Toggle it (a `[[startup]]` hook resumes
it across server restarts while enabled):

```bash
herdr plugin action invoke herdr-plugin-agent-quota.sidebar
```

Metadata values are plain text (ANSI is stripped), so severity color uses
variant tokens instead: each window slot (`u1`, `u2`) has `_ok`/`_warn`/`_bad`
variants and the reporter fills exactly one per slot (used < 50% → ok,
< 80% → warn, ≥ 80% → bad); Herdr hides the valueless rest. `_na` carries an
elapsed window (reset passed, no fresh sample) as an honest `5h -%` so every
window always appears, and `$umodel` names the model an omp pane is running
(read from its session log; that pane's quota follows the model's vendor).
Add the rows to `~/.config/herdr/config.toml` and run
`herdr server reload-config`:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "workspace", "tab"],
  ["agent", { token = "$umodel", dim = true }],
  [
    { token = "$upfx", dim = true },
    { token = "$u1_ok", fg = "#84b084" },
    { token = "$u1_warn", fg = "#cdaa65" },
    { token = "$u1_bad", fg = "#ca6470" },
    { token = "$u1_na", dim = true },
    { token = "$u2_ok", fg = "#84b084" },
    { token = "$u2_warn", fg = "#cdaa65" },
    { token = "$u2_bad", fg = "#ca6470" },
    { token = "$u2_na", dim = true },
  ],
]
```

Behavior is configured with `sidebar.toml` in the plugin config dir
(`herdr plugin config-dir herdr-plugin-agent-quota`), seeded with commented
defaults on first run (a legacy `sidebar.json` is migrated automatically):

```toml
display = "used"
showModel = true

[kindMap]
omp = "claude"
```

- `display` — `"used"` (default) shows consumed percentage; `"remaining"`
  shows what is left (gauges follow, severity still tracks consumption).
  The sidebar, status bar, and `--oneline` output honor the same setting.
- `kindMap` — which vendor's quota an agent kind shows; defaults to
  `claude→CC, codex→CDX, grok→GRX, omp→CC`.
- `showModel` — `true` (default) watches each omp pane's session log, fills
  `$umodel` within about 250 ms of a model change, and routes that pane's quota
  to the model's vendor; `false` keeps the static `kindMap` routing and hides
  the token.

Live snapshots are also cached on disk in the plugin state dir, both as an
offline fallback that beats older file sources and as a cross-process fetch
guard so reporter restarts never hammer vendor endpoints.

### Tab bar entry

`--oneline` prints a single plain-text summary (`CC 5h 59% wk 76% · CDX wk 4% ·
GRX wk 90%`) for a native `ui.tab_bar_right` command entry:

```toml
[ui]
tab_bar_right = [
  { type = "command", command = "node /path/to/herdr-plugin-agent-quota/index.js --oneline", interval_seconds = 60, timeout_seconds = 15 },
]
```

Herdr 0.8.2 tab-bar entries do not expose per-entry foreground/style fields,
and command output has terminal control sequences stripped. Colored `--oneline`
segments therefore require upstream Herdr support; ANSI output cannot add them.

Non-interactive report (same data, plain text):

```bash
node index.js --report --days 30
```

## Pricing

Grok costs are actuals recorded by the Grok CLI. Claude Code and Codex costs
are **estimates** computed from `pricing.toml` in the plugin config dir
(`herdr plugin config-dir herdr-plugin-agent-quota`). The file is seeded with
commented defaults on first run (a legacy `pricing.json` is migrated
automatically) — edit it to match your models; rules match by
case-insensitive substring on the model name, first match wins:

```toml
[[rule]]
match = "opus"
input = 15
output = 75
cacheRead = 1.5
cacheWrite = 18.75
```

Values are USD per million tokens. Models matching no rule are counted in
token totals but excluded from cost.
