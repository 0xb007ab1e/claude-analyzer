# Claude Analyzer

A small **local web app** to browse, read, and (carefully) edit the files that
**Claude Code** stores in a `.claude` directory — settings, resume states,
session transcripts, command history, agents, hooks, skills, plans, tasks, and
more.

It runs entirely on your machine, binds to loopback only, and has **zero runtime
dependencies** — just Node ≥ 22.6 (which can run the TypeScript sources
directly via native type-stripping).

```
┌──────────────────────────────────────────────────────────────┐
│ 🔎 Claude Analyzer        /home/you/.claude      [read/write]  │
├───────────────┬──────────────────────────────────────────────┤
│ 📁 agents     │  .claude / settings.json                       │
│ 📁 projects   │  ─────────────────────────────────────────────│
│   🧵 sess.jsonl│  json · 2.4 KiB · 6/10/2026, 3:01 PM   [✎ Edit]│
│ ⚙️ settings... │  {                                             │
│ 🔒 .credenti… │    "theme": "dark",                            │
│ 📝 CLAUDE.md  │    "apiKey": "«redacted»"   ← redacted by default│
└───────────────┴──────────────────────────────────────────────┘
```

## What it does

- **Browse** the whole `.claude` tree in a lazy-loading file sidebar.
- **Quick open** (⚡ / **Ctrl·⌘K**) — a command palette to fuzzy-find and open any
  file by path (ranked server-side from the live tree cache); ↑↓ to navigate, ↵ to
  open. Served by `/api/paths?q=`. With an empty query it lists your **pinned** (★)
  and **recently opened** (🕘) files; pin/unpin from the palette or the toolbar
  (**☆ Pin**). Recents and pins are kept locally (in the browser, not the server).
- **View** files with type-aware rendering:
  - `.json` — pretty-printed.
  - `.jsonl` — rendered as a list of collapsible records (role/type tagged),
    ideal for reading Claude Code **session transcripts / resume states**.
  - `.md` — rendered Markdown (with a minimal, XSS-safe renderer).
  - text / logs — monospace.
  - binary (images, sqlite, etc.) — shown as a note, not dumped.
- **Find in file** (⌕ Find) — search within the open file with match count and
  next/prev, highlighting matches via the CSS Custom Highlight API (no DOM
  rewriting, so it works across every render mode). Esc to close.
- **Compare** (⇄ Compare) — diff two files: open one, click Compare, then pick a
  second (from the tree or search) for a side-by-side line diff. Redacted by
  default (secrets masked on both sides); Reveal re-runs over raw contents.
  Served by `/api/diff`; binary/over-large files are refused.
- **Edit & save** text files, with guardrails (see below).
- **Redact secrets by default**; revealing raw contents is an explicit action.

## Features — the Views menu

A **▾ Views** menu opens analytical panels layered over the `.claude` tree:

- **🔍 Search files** — full-text search across the whole tree (file *contents*, not
  just names). Case-insensitive, results grouped by file with line numbers and
  **redacted** snippets (open a file to reveal); click a hit to **jump to that line**
  — a line-numbered view scrolled to and highlighting the match (works even in the
  multi-MiB transcripts). Bounded and time-budgeted; served by `/api/search`.
- **🕒 Activity log** — a live feed of filesystem changes as Claude Code writes them.
- **🗂 Projects** — decodes `projects/<encoded-cwd>/` back to real working directories
  and groups each project's sessions; click a session to open its transcript.
- **⚙ Settings** — the effective settings merged across global / project / local
  layers, a diff against the most recent `.bak`, and flags for unknown keys.
- **🧩 Extensions** — hooks, agents, skills, slash commands, and MCP servers parsed
  from the tree (with auth status).
- **🕰 File history** — `file-history/` edit snapshots with a side-by-side diff and a
  guarded restore.
- **📊 Usage & cost** — sessions, token totals, and an estimated cost, charted from
  `history.jsonl`, stats, and session transcripts.
- **📅 Activity timeline** — a GitHub-style calendar heatmap plus an hour-of-day chart
  of when the folder is active.
- **🕸 Relationship graph** — links artifacts that share session UUIDs (see below).
- **🛡 Security audit** — scans for secret-shaped values, world/group-readable
  sensitive files, and stale / reclaimable data.
- **📈 Observability** — the server's own RED metrics (throughput, success/error
  rate, latency avg/p50/p95/p99 + histogram, a status-code distribution, and a
  **per-route KPI table**) plus a **persistent event journal** that records
  filesystem changes, reveals, writes, and restores over time — so you can see
  *how* the `.claude` folder is used across restarts, not just live. Everything
  is **drillable**: click a route, an event kind, a heatmap day, or a path to
  open a detail panel (filtered events + summary). The journal is stored outside
  the watched root (XDG state dir) and holds metadata only — paths and event
  kinds, never file contents. Exposed as JSON at `/api/metrics`,
  `/api/observability`, and `/api/journal?kind=&path=&from=&to=`.

A toolbar **🔗 Source** button cross-references the open file against the **Claude Code
source repository**, showing where that artifact is read or written in the code.

### Live directory watch

The server watches the root and streams changes to the browser, **flashing** changed
files in the tree, adding/removing rows for created/deleted files in expanded folders,
and refreshing the open file in place. A directory changed while collapsed reloads when
you re-expand it, so the tree never shows stale contents. A **● live / ❚❚ no flash**
toggle pauses the flashing while the activity log keeps recording.

The same watch stream maintains an in-memory **file-tree cache** (path → mtime) that backs
the relationship graph and activity timeline, so those views render without re-walking the
whole tree on every request (a TTL rebuild and a watch-error fallback guard against drift).

### Names: friendly ⇄ UUID

A global **name-mode toggle** (in the **▾ Views** menu, and as a checkbox in the
graph controls) switches every name-bearing view between **friendly** project
names (derived from the path, minus directory identifiers) and raw **UUIDs /
full paths**. It applies to the relationship graph, the Projects panel, the
Usage dashboard, and the session-viewer header, and is remembered between
sessions. Project working directories are read from the session transcripts, so
the displayed paths and the Projects "exists" badge are accurate (not a guess
from the lossy `projects/` directory-name encoding).

### Relationship graph

- **Force** (default) layout, or a **Grid** of per-cluster cells (radial hub + rings).
- Each connected group (a session hub + its files) gets a **unique colour** for its
  nodes and edges; hubs are labelled by project/session (or UUID — see the name
  toggle above), files by kind.
- **Search** to centre + highlight a group (matches project name *or* UUID); **filter**
  by kind, top-N, or hide trivial 2-node groups; **zoom** with +/−, scroll, or pinch;
  tap a file node to open it.

### Safety

- **Secrets redacted by default** (`.credentials.json`, tokens, keys); revealing raw
  contents is an explicit, audit-logged action.
- **Guarded writes**: JSON/JSONL validated, a timestamped backup saved under
  `.analyzer-backups/` before overwrite, then a confirm step.
- **Confined to the configured root** (no path traversal), **loopback bind** with a Host
  allowlist (anti-DNS-rebinding), and an optional **read-only** mode.

## Quick start

```bash
# Default: opens ~/.claude on loopback
npm start

# Iterate with hot reload (server restarts on src changes; browser auto-reloads)
npm run dev

# Reach it from your network / phone over Tailscale, as http://parrot:4317/
npm run lan          # = --watch --host 0.0.0.0 (hot reload + LAN access)
```

Then open the printed URL (loopback default <http://127.0.0.1:4317/>).

### Reaching it at `parrot:<port>`

The server only serves requests whose `Host` header is on an **allowlist**
(anti-DNS-rebinding). The machine hostname (`parrot`) is always allowed, so you
just need to bind a reachable interface:

```bash
npm run lan                                   # binds 0.0.0.0 → http://parrot:4317/
# add other names/IPs (e.g. a Tailscale MagicDNS name) explicitly:
node --experimental-strip-types src/server.ts --host 0.0.0.0 --allow-host my-box.tailnet.ts.net
```

A request with any other `Host` (e.g. `evil.com`) gets `403 forbidden host`.

### Hot reload

On by default. The browser reloads automatically when you (a) edit a file under
`public/` — the server watches it and pushes a reload over SSE — or (b) edit a
file under `src/` while running with `--watch` (`npm run dev`/`lan`): the server
restarts and the browser reloads on reconnect. Disable with `--no-reload`.

### Options

| Flag / env | Default | Meaning |
|---|---|---|
| `--root <dir>` / `CLAUDE_DIR` | `~/.claude` | The `.claude` directory to operate on |
| `--port <n>` / `PORT` | `4317` | TCP port |
| `--host <h>` / `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to reach by hostname) |
| `--allow-host <h>` / `ALLOW_HOST` | hostname + loopback | Extra `Host` values to accept (repeatable; `ALLOW_HOST` is comma-separated) |
| `--read-only` | off | Disable all writes (browse-only) |
| `--no-reload` | reload on | Disable the live-reload SSE endpoint |
| `CA_TOKEN` / `--token-file <path>` / `--token <v>` | none | Require a bearer **access token** on every `/api/*` request (prefer `CA_TOKEN` or a file — `--token` is visible in process listings) |

## Security model

This app is a deliberate read/**write** window onto a directory full of real
secrets, so its safety properties are explicit and tested:

- **Path confinement (CWE-22).** Every filesystem access is routed through
  `safeResolve`, which rejects `../` traversal and **symlinks that escape the
  root** (checked via `realpath`, including the parent of not-yet-created files).
  This is the critical path and is covered at 100% in `test/paths.test.ts`.
- **Secrets redacted by default.** `.credentials.json` and other sensitive
  files are fully masked; sensitive-looking keys (`*token*`, `*secret*`, …) and
  inline credential patterns (`sk-ant-…`, JWTs, `Bearer …`, AWS keys, GitHub
  tokens) are redacted in any file. Showing raw bytes requires the **Reveal**
  button (confirmed) and is **audit-logged** server-side. See `src/redact.ts`
  and `test/redact.test.ts`.
- **Edit guardrails.** Saving validates JSON / JSONL, writes a **timestamped
  backup** into `.analyzer-backups/` first, and requires an in-UI confirm. The
  UI warns if you try to save a *redacted* view (which would overwrite the real
  secret with the mask).
- **Host allowlist (anti-DNS-rebinding).** Binds to `127.0.0.1` by default and
  rejects any request whose `Host` header isn't on the allowlist (loopback +
  the machine hostname + any `--allow-host`). Binding `0.0.0.0` makes it
  reachable by hostname (e.g. `parrot`) while still rejecting unknown hosts.
- **Optional access token (defense in depth).** Set `CA_TOKEN` (or
  `--token-file`) to require a bearer token on every `/api/*` request — useful
  when binding to a LAN/Tailscale interface, so a Host-allowlist match alone
  isn't enough. The static UI shell still loads and prompts for the token (held
  in memory, never persisted); it rides as an `Authorization: Bearer` header, or
  a `?token=` query for `EventSource` / `<img>`/`<embed>`. Comparison is
  constant-time. Auth is **off by default** (loopback use needs no token).
- **No secrets in code or logs.** Reveal actions log only the file path, never
  the values.

> This is a **local developer tool**, not a hardened multi-user service. Don't
> expose it on a public interface. Treat any file you Reveal as live secret
> material.

## Architecture

```
src/
  server.ts   HTTP server, routing, static serving, host allowlist, SSE live-reload
  config.ts   root/host/port/allow-host/reload resolution + validation (fail-fast)
  paths.ts    SECURITY-CRITICAL path confinement (safeResolve)
  files.ts    list / classified read (+redaction) / guarded write (+backup)
  redact.ts   secret detection & redaction
public/
  index.html  UI shell
  app.js      tree, type-aware viewers, reveal, guarded editor, live-reload (no build step)
  styles.css
test/
  paths.test.ts   confinement (traversal, symlink escape, …)
  redact.test.ts  redaction coverage
```

Pure logic (`paths`, `redact`, classification) is isolated from I/O so it's
unit-testable without mocks; `server.ts` is the thin imperative shell.

## Develop & test

```bash
npm test        # node:test, runs the security-critical suites
npm run dev     # server with --watch
```

Type-checking gate (optional, requires installing TypeScript):
`npx tsc --noEmit` — the sources are written for `strict` mode.

## License

[0BSD](LICENSE) (BSD Zero Clause License) — public-domain-equivalent: use, copy,
modify, and distribute freely, no attribution required. The project has zero
runtime dependencies, so there are no third-party license obligations.
