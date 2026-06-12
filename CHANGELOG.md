# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-06-12

### Added

- Global **Friendly ⇄ UUID name toggle** (Views menu + graph controls): show
  friendly project-derived names (path minus directory identifiers) or raw
  UUIDs / full paths across the relationship graph, Projects, Usage, and the
  session viewer. Persisted; graph search matches both forms.

### Fixed

- Relationship-graph overlay header now renders cleanly on mobile — the header
  row wraps, the long stats line is hidden, and the controls stack.

## [0.1.1] - 2026-06-12

### Added

- Automated release pipeline: pushing a `vX.Y.Z` tag now verifies the test +
  coverage gate and publishes a GitHub Release from the matching `CHANGELOG`
  section (`.github/workflows/release.yml`).

## [0.1.0] - 2026-06-12

Initial release — a local, **zero-dependency** web app to browse, read, and
(carefully) edit the files Claude Code stores in a `.claude` directory (settings,
sessions/resume states, history, agents, hooks, skills, plans, tasks, and more).
Runs on Node ≥ 22.6 via native TypeScript type-stripping; no build step.

### Added

- **Browse** the whole `.claude` tree in a lazy-loading file sidebar.
- **Type-aware viewers**: pretty-printed JSON; collapsible/role-tagged JSONL with
  a rich session-transcript view; safe Markdown; monospace text; binary noted.
- **Guarded editing**: JSON/JSONL validation, a timestamped backup under
  `.analyzer-backups/` before overwrite, and a confirm step; optional
  `--read-only` mode.
- **Live directory watch**: changed files flash in the tree, the open file
  refreshes in place, and an activity log records changes; **● live / ❚❚ no
  flash** toggle.
- **Access & dev**: loopback by default with a Host-header allowlist
  (anti-DNS-rebinding), opt-in non-loopback binding for hostname/LAN/Tailscale
  access, and SSE-based hot reload.
- **Mobile-responsive UI** with a grouped **▾ Views** menu.
- **Views**: Settings explorer (layered merge + `.bak` diff + unknown-key flags),
  Usage & cost dashboard, Activity timeline (calendar heatmap), File history
  (snapshot diff + guarded restore), Extensions explorer (hooks/agents/skills/
  commands/MCP), Project map (decoded cwd + sessions), Security audit, Source
  cross-reference (`🔗 Source`), and a Relationship graph (force or grid layout,
  per-cluster colours, search/filter, zoom & pinch).

### Security

- **Path confinement** — all file access resolved and confined to the configured
  root, including symlink checks (no traversal).
- **Secrets redacted by default**; revealing raw contents is an explicit,
  audit-logged action.
- **Zero runtime dependencies**; loopback bind + Host allowlist; guarded writes.

### Tooling

- 229 unit tests; CI on Node 22 & 24 with a **coverage gate** (lines ≥ 90 /
  branches ≥ 88 / functions ≥ 95) and a **gitleaks secret scan** (pinned +
  checksum-verified); SHA-pinned actions, least-privilege permissions.
- **0BSD** license; `SECURITY.md` with private vulnerability reporting.

[0.1.2]: https://github.com/0xb007ab1e/claude-analyzer/releases/tag/v0.1.2
[0.1.1]: https://github.com/0xb007ab1e/claude-analyzer/releases/tag/v0.1.1
[0.1.0]: https://github.com/0xb007ab1e/claude-analyzer/releases/tag/v0.1.0
