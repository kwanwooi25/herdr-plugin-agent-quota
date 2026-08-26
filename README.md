# herdr-plugins

[Herdr](https://herdr.dev) plugins by [@kwanwooi25](https://github.com/kwanwooi25).
Each plugin lives in its own subdirectory and installs independently.

| Plugin | Install | Description |
|---|---|---|
| [agent-usage](agent-usage/) | `herdr plugin install kwanwooi25/herdr-plugins/agent-usage` | Token & cost usage dashboard, sidebar quota gauges, and tab bar summary for Claude Code, Codex, and Grok |

## agent-usage at a glance

- **Dashboard popup** — daily token/cost breakdown per agent with per-model detail.
- **Sidebar usage tokens** — live per-agent quota gauges rendered inside Herdr's
  agent sidebar via pane metadata, with severity colors, used/remaining display
  modes, and per-pane model detection for omp.
- **Tab bar entry** — one-line summary for `ui.tab_bar_right`.
- **Statusbar pane** — compact always-on rate-limit bar.
- Local-only: credentials are read from each CLI's own login state and sent
  only to that vendor's API; nothing else leaves the machine.

See [agent-usage/README.md](agent-usage/README.md) for full setup.
