# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.10] - 2026-06-13

### Added

- **Jump to line from search.** Clicking a search hit now opens the file in a
  line-numbered view scrolled to and **highlighting the matched line**, instead
  of opening it at the top. Backed by the existing `/api/file-lines` endpoint, so
  it works for any text file — chunked or not, including the multi-MiB
  transcripts (it loads the window containing the line). "Load more" pages
  forward and "Open full file" returns to the rich renderer; lines stay redacted
  by default. Selecting a result also closes the search overlay.

## [0.1.9] - 2026-06-12

### Added

- **Optional access-token auth (LAN/Tailscale hardening).** Set `CA_TOKEN` (or
  `--token-file` / `--token`) to require a bearer token on every `/api/*`
  request — defense in depth on top of the Host allowlist for non-loopback
  binds. The static UI shell still loads and prompts for the token (held in
  memory, never persisted); it travels as an `Authorization: Bearer` header, or
  a `?token=` query for `EventSource` / `<img>` / `<embed>` / downloads.
  Comparison is constant-time. **Off by default** — loopback use needs no token.
  `/api/config` now reports `authRequired`.

## [0.1.8] - 2026-06-12

### Added

- **Live file-tree cache.** An in-memory `path → mtime` index, built once and
  kept current incrementally from the filesystem-watch events, now backs the
  relationship graph and activity timeline — so those views render without
  re-walking the whole tree on every request (~20 ms vs. a full 20k-file walk).
  Guarded against watcher drift by a 5-minute TTL rebuild and a forced rebuild
  on watch error.

### Fixed

- The file tree no longer shows stale contents for a directory that changed
  while it was **collapsed**: such a directory is now reloaded the next time it
  is expanded (previously only currently-expanded directories were reconciled
  live).

### Changed

- Removed the per-request full tree walk (`walkFiles`/`collectMtimes`) from the
  graph and activity endpoints in favour of the cache.

## [0.1.7] - 2026-06-12

### Added

- **Full-text search (🔍 Search files).** Search file *contents* across the
  whole `.claude` tree — case-insensitive, text files only, streamed
  line-by-line so multi-MiB transcripts are handled. Results are grouped by file
  with line numbers and **redacted** snippets (a hit on a secret shows the mask,
  never the value); query terms are highlighted and clicking a hit opens the
  file. Plain-substring matching (no regex / no ReDoS), and bounded on every
  axis — files scanned, hits per file, total matches, lines per file, plus a 5s
  wall-clock budget — surfaced as a `truncated`/`capped` flag. Served by
  `GET /api/search?q=`; queries shorter than 2 characters are rejected.

## [0.1.6] - 2026-06-12

### Added

- **Observability drill-downs — "KPI everything".** The 📈 Observability view
  expands from summary tiles into a full, drillable KPI surface:
  - **Server health:** throughput (req/min), success rate, error rate.
  - **Request latency:** avg / p50 / p95 / p99 / max plus a latency histogram.
  - **Status codes:** a 2xx/3xx/4xx/5xx distribution bar.
  - **Requests by route:** a per-route KPI table (reqs, share, 2xx/4xx/5xx, and
    new per-route avg & max latency).
  - **Journal stats:** size on disk, all-time event count, oldest→newest span.
  - **Drill-downs:** click a route row, an event-kind bar, a heatmap day, a
    counter card, or a path's history button to open a pinned detail panel with
    a filtered event slice + summary (count, span, kind/op breakdown, top
    paths), served by the new read-only `GET /api/journal?kind=&path=&from=&to=`
    endpoint.

## [0.1.5] - 2026-06-12

### Added

- **Observability tracker.** A new **📈 Observability** view surfaces the
  server's own RED metrics (request rate, error rate, latency avg/p95/max,
  uptime, memory) alongside a **persistent event journal** that records
  filesystem changes, secret reveals, writes, and restores over time — so usage
  of the `.claude` folder is visible *historically*, across restarts, not just
  live. The journal is stored in the XDG state directory **outside** the watched
  root (no watcher feedback loop) and holds metadata only — paths and event
  kinds, never file contents or revealed secrets. Also exposed as JSON at
  `GET /api/metrics` and `GET /api/observability?days=N`.

### Tooling

- Added an end-to-end HTTP **smoke test** that boots the real server as a child
  process and exercises the API (config/list/file-lines/raw, path-traversal
  rejection, disallowed-Host rejection, metrics, observability), making the
  server's I/O paths e2e-covered.

## [0.1.4] - 2026-06-12

### Added

- **Chunked loader for large text/JSONL.** Over-cap transcripts no longer show
  "too large to display" — they are streamed in pages via
  `GET /api/file-lines?path&from&count&reveal` (server-side line windowing,
  capped at 2000 lines/request, redacted per line, with `total`/`hasMore`). The
  session timeline and a plain-text view render incrementally with a **Load
  more** control, so multi-MiB sessions open fine. Edit is disabled for chunked
  files (the whole file is never held client-side).
- **Native binary viewers.** `GET /api/raw?path[&download=1]` streams raw bytes
  with the correct `Content-Type` (root-confined, `X-Content-Type-Options:
  nosniff`, inline or attachment). The UI renders **images** inline, **PDFs** in
  an embedded viewer, and a **Download / Open** bar for any other binary.

## [0.1.3] - 2026-06-12

### Fixed

- Projects panel no longer shows spurious "missing" badges. The working
  directory is now read from the project's session transcript (the real `cwd`)
  instead of the lossy `projects/` directory-name decode, so existence checks
  and displayed/friendly names are accurate. The session-viewer header uses the
  same real cwd.

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

[0.1.10]: https://github.com/0xb007ab1e/claude-analyzer/releases/tag/v0.1.10
[0.1.9]: https://github.com/0xb007ab1e/claude-analyzer/releases/tag/v0.1.9
[0.1.8]: https://github.com/0xb007ab1e/claude-analyzer/releases/tag/v0.1.8
[0.1.7]: https://github.com/0xb007ab1e/claude-analyzer/releases/tag/v0.1.7
[0.1.6]: https://github.com/0xb007ab1e/claude-analyzer/releases/tag/v0.1.6
[0.1.5]: https://github.com/0xb007ab1e/claude-analyzer/releases/tag/v0.1.5
[0.1.4]: https://github.com/0xb007ab1e/claude-analyzer/releases/tag/v0.1.4
[0.1.3]: https://github.com/0xb007ab1e/claude-analyzer/releases/tag/v0.1.3
[0.1.2]: https://github.com/0xb007ab1e/claude-analyzer/releases/tag/v0.1.2
[0.1.1]: https://github.com/0xb007ab1e/claude-analyzer/releases/tag/v0.1.1
[0.1.0]: https://github.com/0xb007ab1e/claude-analyzer/releases/tag/v0.1.0
