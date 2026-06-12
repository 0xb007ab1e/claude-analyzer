/**
 * Claude Analyzer — local HTTP server.
 *
 * A zero-dependency Node server that exposes a small JSON API over one confined
 * `.claude` root and serves the static browser UI. It binds to loopback only
 * and rejects requests whose Host header isn't loopback (defense against DNS
 * rebinding from a malicious page in the same browser).
 *
 * Run:  node --experimental-strip-types src/server.ts [--root DIR] [--port N] [--read-only]
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { watch, createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, sep } from "node:path";
import { loadConfig, ConfigError, type Config } from "./config.ts";
import {
  listDir,
  readFileClassified,
  writeFileGuarded,
  readFileLines,
  resolveInRoot,
  extOf,
  contentType,
  BACKUP_DIR,
} from "./files.ts";
import { PathError, toRelative } from "./paths.ts";
import { searchTree } from "./xref.ts";
import { sessionInfo, extractSessionCwd } from "./sessions.ts";
import { readSettings } from "./settings.ts";
import { collectUsage } from "./usage.ts";
import { collectMtimes, summarize } from "./activity.ts";
import { listHistory, getHistoryEntry, restoreHistoryEntry } from "./history.ts";
import { gatherExtensions } from "./extensions.ts";
import { listProjects } from "./projects.ts";
import { buildGraph, trimGraph, type GraphStats } from "./graph.ts";
import { runAudit } from "./auditHandler.ts";
import { Metrics, routeLabel } from "./metrics.ts";
import { Journal, resolveJournalDir, aggregateEvents } from "./journal.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MiB write cap

/**
 * Unique per-process id. The client uses it to distinguish a real server
 * restart (id changes → reload the page) from a mere SSE reconnect after a
 * network blip (same id → do nothing). This stops phones/Tailscale from
 * reloading the whole UI every time the long-lived connection drops.
 */
const BOOT_ID = `${Date.now().toString(36)}-${process.pid.toString(36)}`;

/**
 * Observability singletons, initialised in {@link main}. Module-scoped because
 * the {@link log} chokepoint (called from many places without a handle to them)
 * forwards audit/error events here. Both are non-null for the life of a request
 * since {@link main} sets them before the server starts listening.
 */
let metrics: Metrics | null = null;
let journal: Journal | null = null;

/** Static file content types. */
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * Maximum number of files visited by {@link walkFiles}.
 * Prevents runaway I/O on very large trees while still covering typical roots.
 */
const WALK_FILE_CAP = 20_000;

/**
 * Recursively collect all file paths under `dir`, confined to `root`.
 *
 * Skips `.git`, `.analyzer-backups`, and `node_modules` subtrees. Stops once
 * {@link WALK_FILE_CAP} files have been found and returns the partial list with
 * the `capped` flag set to true.
 *
 * @param root    Absolute, already-realpath'd root (confinement boundary).
 * @param dir     Absolute starting directory (must be inside root).
 * @param out     Accumulator array of root-relative forward-slash paths.
 * @param capped  [out] set to true when the file cap is reached.
 */
async function walkFiles(
  root: string,
  dir: string,
  out: string[],
  capped: { value: boolean },
): Promise<void> {
  if (capped.value) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip silently
  }
  for (const d of entries) {
    if (capped.value) return;
    // Skip well-known noise directories.
    if (d.name === ".git" || d.name === ".analyzer-backups" || d.name === "node_modules") {
      continue;
    }
    const abs = join(dir, d.name);
    // Confine: skip anything that resolves outside root (e.g. symlinks).
    if (!abs.startsWith(root + sep) && abs !== root) continue;
    if (d.isDirectory()) {
      await walkFiles(root, abs, out, capped);
    } else if (d.isFile() || d.isSymbolicLink()) {
      out.push(toRelative(root, abs));
      if (out.length >= WALK_FILE_CAP) {
        capped.value = true;
        return;
      }
    }
  }
}

function main(): void {
  let config: Config;
  try {
    config = loadConfig(process.argv.slice(2));
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`\n${e.message}\n\n`);
      process.exit(2);
    }
    throw e;
  }

  // Observability: in-process RED metrics + a persistent event journal stored
  // OUTSIDE the watched root (so the watcher never observes its own writes).
  metrics = new Metrics(BOOT_ID, Date.now());
  journal = new Journal(resolveJournalDir(config.root));

  // Connected SSE clients. The server watches the root and pushes `fschange`
  // events (the live directory-watch feature) to all of them; under --reload it
  // also pushes `reload` events when the UI's own assets change.
  const liveClients = new Set<ServerResponse>();
  startWatchers(liveClients, config);

  const server = createServer((req, res) => {
    // Per-request RED metrics. The SSE stream is long-lived, so recording its
    // latency on `finish` would skew the histogram — count it once at connect
    // with zero duration instead.
    const start = Date.now();
    let path = "/";
    try {
      path = new URL(req.url ?? "/", "http://x").pathname;
    } catch {
      /* malformed URL — keep "/" */
    }
    const lbl = routeLabel(req.method ?? "GET", path);
    if (lbl === "GET /api/events") {
      metrics?.recordRequest(lbl, 200, 0);
    } else {
      res.on("finish", () => metrics?.recordRequest(lbl, res.statusCode, Date.now() - start));
    }

    handle(req, res, config, liveClients).catch((err) => {
      log("error", `unhandled: ${(err as Error).message}`);
      sendJson(res, 500, { error: "internal error" });
    });
  });

  server.listen(config.port, config.host, () => {
    const reachable = config.host === "0.0.0.0" || config.host === "::"
      ? config.allowedHosts.filter((h) => h !== "127.0.0.1" && h !== "::1" && h !== "[::1]")
      : [config.host];
    const urls = reachable.map((h) => `http://${h}:${config.port}/`).join("\n          ");
    process.stdout.write(
      `\nClaude Analyzer\n` +
        `  root:   ${config.root}\n` +
        `  mode:   ${config.allowWrite ? "read/write" : "read-only"}` +
        `${config.reload ? " · hot-reload on" : ""}\n` +
        `  source: ${config.sourceDir ?? "(not configured — xref feature unavailable)"}\n` +
        `  bind:   ${config.host}:${config.port}\n` +
        `  open:   ${urls}\n` +
        `  hosts:  ${config.allowedHosts.join(", ")}\n` +
        (config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1"
          ? `\n  ⚠ Bound to a non-loopback interface — reachable from your network.\n` +
            `    Only allow-listed Host headers are served; don't expose this publicly.\n`
          : "") +
        `\nSecrets are redacted by default; click “Reveal” on a file to show raw values.\n` +
        `Press Ctrl+C to stop.\n`,
    );
  });
}

/** Top-level request router. */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  liveClients: Set<ServerResponse>,
): Promise<void> {
  // Anti-DNS-rebinding: only serve Host headers on the allowlist.
  if (!isAllowedHost(req.headers.host, config.allowedHosts)) {
    sendJson(res, 403, { error: "forbidden host" });
    return;
  }

  // Server-Sent Events stream: directory-watch (`fschange`) + dev hot-reload
  // (`reload`). Long-lived connection; returns early. Always available.
  if (req.url && new URL(req.url, "http://x").pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(":connected\n\n");
    res.write(`event: hello\ndata: ${JSON.stringify({ bootId: BOOT_ID })}\n\n`);
    liveClients.add(res);
    req.on("close", () => liveClients.delete(res));
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  try {
    if (path === "/api/config" && req.method === "GET") {
      sendJson(res, 200, {
        root: config.root,
        allowWrite: config.allowWrite,
        reload: config.reload,
      });
      return;
    }

    if (path === "/api/settings" && req.method === "GET") {
      const reveal = url.searchParams.get("reveal") === "1";
      if (reveal) log("audit", "reveal raw settings");
      sendJson(res, 200, await readSettings(config.root, reveal));
      return;
    }

    if (path === "/api/list" && req.method === "GET") {
      const rel = url.searchParams.get("path") ?? "";
      sendJson(res, 200, await listDir(config.root, rel));
      return;
    }

    if (path === "/api/usage" && req.method === "GET") {
      sendJson(res, 200, await collectUsage({ root: config.root }));
      return;
    }

    if (path === "/api/activity" && req.method === "GET") {
      const rawDays = url.searchParams.get("days");
      const days = Math.max(1, Math.min(365, parseInt(rawDays ?? "90", 10) || 90));
      const { mtimesMs, truncated } = await collectMtimes(config.root);
      sendJson(res, 200, summarize(mtimesMs, days, Date.now(), truncated));
      return;
    }

    if (path === "/api/projects" && req.method === "GET") {
      sendJson(res, 200, await listProjects(config.root));
      return;
    }

    // App self-metrics (RED) — machine-readable JSON.
    if (path === "/api/metrics" && req.method === "GET") {
      sendJson(res, 200, metrics!.snapshot(Date.now(), process.memoryUsage().rss));
      return;
    }

    // Observability dashboard payload: aggregated event history (from the
    // persistent journal) + a recent-events tail + the current metrics snapshot.
    if (path === "/api/observability" && req.method === "GET") {
      const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get("days") ?? "30", 10) || 30));
      const now = Date.now();
      // Pull a window slightly wider than requested so day-boundary events at
      // the edge aren't dropped, then aggregate to the exact window.
      const events = await journal!.query({ sinceMs: now - (days + 1) * 86_400_000, limit: 5000 });
      sendJson(res, 200, {
        aggregate: aggregateEvents(events, now, days),
        recent: events.slice(0, 50),
        metrics: metrics!.snapshot(now, process.memoryUsage().rss),
        journalDir: journal!.dir,
      });
      return;
    }

    if (path === "/api/audit" && req.method === "GET") {
      log("audit", "security audit scan requested");
      sendJson(res, 200, await runAudit(config.root));
      return;
    }

    if (path === "/api/file" && req.method === "GET") {
      const rel = url.searchParams.get("path") ?? "";
      const reveal = url.searchParams.get("reveal") === "1";
      if (reveal) log("audit", `reveal raw content: ${rel}`);
      const fileData = await readFileClassified(config.root, rel, reveal);
      // Annotate transcript files with session metadata so the UI can render a
      // rich timeline instead of the generic JSONL view. Prefer the real cwd
      // recorded in the transcript over the lossy directory-name decode.
      const session = sessionInfo(fileData.path);
      if (session.isSession && typeof fileData.content === "string") {
        const realCwd = extractSessionCwd(fileData.content);
        if (realCwd) session.cwd = realCwd;
      }
      sendJson(res, 200, { ...fileData, session });
      return;
    }

    // Chunked line window for large text/JSONL files (streamed server-side).
    if (path === "/api/file-lines" && req.method === "GET") {
      const rel = url.searchParams.get("path") ?? "";
      const from = parseInt(url.searchParams.get("from") ?? "0", 10) || 0;
      const count = parseInt(url.searchParams.get("count") ?? "200", 10) || 200;
      const reveal = url.searchParams.get("reveal") === "1";
      if (reveal) log("audit", `reveal raw lines: ${rel}`);
      sendJson(res, 200, await readFileLines(config.root, rel, from, count, reveal));
      return;
    }

    // Raw bytes of a confined file, for inline image/PDF viewing or download.
    if (path === "/api/raw" && req.method === "GET") {
      const rel = url.searchParams.get("path") ?? "";
      const abs = await resolveInRoot(config.root, rel);
      const st = await stat(abs); // throws ENOENT → 404 below
      if (st.isDirectory()) throw new PathError("path is a directory", 400);
      const download = url.searchParams.get("download") === "1";
      const base = rel.split("/").pop() ?? "file";
      res.writeHead(200, {
        "content-type": contentType(extOf(rel)),
        "content-length": String(st.size),
        "cache-control": "no-store",
        // inline for viewers; attachment forces a download.
        "content-disposition": `${download ? "attachment" : "inline"}; filename="${base.replace(/[^\w.\-]/g, "_")}"`,
        // images/pdf only; never let the browser treat this as active content.
        "x-content-type-options": "nosniff",
      });
      createReadStream(abs).pipe(res);
      return;
    }

    // -----------------------------------------------------------------------
    // History endpoints
    // -----------------------------------------------------------------------

    if (path === "/api/history/list" && req.method === "GET") {
      sendJson(res, 200, await listHistory(config.root));
      return;
    }

    if (path === "/api/history/entry" && req.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const reveal = url.searchParams.get("reveal") === "1";
      if (!id) {
        sendJson(res, 400, { error: "missing 'id' query parameter" });
        return;
      }
      if (reveal) log("audit", `reveal history entry raw content: ${id}`);
      sendJson(res, 200, await getHistoryEntry(config.root, id, reveal));
      return;
    }

    if (path === "/api/history/restore" && req.method === "POST") {
      if (!config.allowWrite) {
        sendJson(res, 403, { error: "server is in read-only mode" });
        return;
      }
      const body = await readBody(req);
      let obj: unknown;
      try {
        obj = JSON.parse(body);
      } catch {
        throw new RequestError("body must be JSON");
      }
      if (typeof obj !== "object" || obj === null) throw new RequestError("body must be an object");
      const { id } = obj as Record<string, unknown>;
      if (typeof id !== "string" || id === "") throw new RequestError("missing 'id'");
      log("audit", `restore history snapshot: ${id}`);
      const result = await restoreHistoryEntry(config.root, id);
      sendJson(res, 200, result);
      return;
    }

    if (path === "/api/extensions" && req.method === "GET") {
      const reveal = url.searchParams.get("reveal") === "1";
      if (reveal) log("audit", "reveal raw extensions (hooks/mcp secrets unredacted)");
      sendJson(res, 200, await gatherExtensions(config.root, reveal));
      return;
    }

    if (path === "/api/file" && req.method === "POST") {
      if (!config.allowWrite) {
        sendJson(res, 403, { error: "server is in read-only mode" });
        return;
      }
      const body = await readBody(req);
      const parsed = parseWriteBody(body);
      log("audit", `write: ${parsed.path} (${Buffer.byteLength(parsed.content)} bytes)`);
      const result = await writeFileGuarded(config.root, parsed.path, parsed.content);
      sendJson(res, 200, result);
      return;
    }

    if (path === "/api/xref" && req.method === "GET") {
      if (!config.sourceDir) {
        sendJson(res, 200, {
          available: false,
          message:
            "Source cross-reference is not configured. " +
            "Start the server with --source <dir> or set the CLAUDE_SRC environment variable " +
            "to the Claude Code source repository path.",
        });
        return;
      }
      const rawName = url.searchParams.get("name") ?? "";
      const token = sanitiseToken(rawName);
      if (token === "") {
        throw new PathError("'name' query parameter is required and must be non-empty", 400);
      }
      log("info", `xref search: ${token}`);
      const result = await searchTree(config.sourceDir, token);
      sendJson(res, 200, result);
      return;
    }

    if (path === "/api/graph" && req.method === "GET") {
      const filePaths: string[] = [];
      const capped = { value: false };
      await walkFiles(config.root, config.root, filePaths, capped);
      const rawGraph = buildGraph(filePaths);
      const trimmed = trimGraph(rawGraph);
      const stats: GraphStats = {
        files: filePaths.length,
        uuids: rawGraph.nodes.filter((n) => n.type === "uuid").length,
        truncated: trimmed.truncated || capped.value,
      };
      sendJson(res, 200, { nodes: trimmed.nodes, edges: trimmed.edges, stats });
      return;
    }

    if (req.method === "GET") {
      await serveStatic(path, res);
      return;
    }

    sendJson(res, 405, { error: "method not allowed" });
  } catch (e) {
    if (e instanceof PathError) {
      sendJson(res, e.status, { error: e.message });
      return;
    }
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (e instanceof RequestError) {
      sendJson(res, e.status, { error: e.message });
      return;
    }
    log("error", `request failed: ${(e as Error).message}`);
    sendJson(res, 500, { error: "internal error" });
  }
}

/** Serve a file from the public/ directory (the UI). Never escapes public/. */
async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const clean = path === "/" ? "/index.html" : path;
  // Confine: strip any traversal, resolve under PUBLIC_DIR.
  const safe = clean.replace(/\.\.+/g, "").replace(/^\/+/, "");
  const abs = join(PUBLIC_DIR, safe);
  if (!abs.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  try {
    const data = await readFile(abs);
    const type = STATIC_TYPES[extname(abs).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

/** An error with an explicit client-facing status. */
class RequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Read a request body with a hard size cap. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new RequestError("request body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Sanitise a user-supplied token for the xref search.
 *
 * Strips path separators (`/`, `\`) and null bytes so the token can never be
 * used to navigate the filesystem or inject control characters. The result is
 * used as a plain substring, not a regex, so no further escaping is needed.
 *
 * @param raw  The raw `name` query parameter value.
 * @returns  The sanitised token, or an empty string if nothing remains.
 */
function sanitiseToken(raw: string): string {
  // Remove path separators, null bytes, and leading/trailing whitespace.
  return raw.replace(/[/\\]/g, "").replace(/\0/g, "").trim();
}

/** Parse and validate the write request body. */
function parseWriteBody(body: string): { path: string; content: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(body);
  } catch {
    throw new RequestError("body must be JSON");
  }
  if (typeof obj !== "object" || obj === null) throw new RequestError("body must be an object");
  const { path, content } = obj as Record<string, unknown>;
  if (typeof path !== "string" || path === "") throw new RequestError("missing 'path'");
  if (typeof content !== "string") throw new RequestError("missing 'content'");
  return { path, content };
}

/**
 * Allow the request only if its Host header is on the configured allowlist
 * (prevents DNS-rebinding: a malicious page can't drive this server via a
 * rebound name it doesn't control). Port is ignored in the comparison.
 */
function isAllowedHost(host: string | undefined, allowed: string[]): boolean {
  if (!host) return false;
  const name = host.split(":")[0]?.toLowerCase() ?? "";
  return allowed.includes(name);
}

/** Write one SSE event to every client; drop any that error. */
function broadcast(clients: Set<ServerResponse>, event: string, data: string): void {
  const frame = `event: ${event}\ndata: ${data}\n\n`;
  for (const c of clients) {
    try {
      c.write(frame);
    } catch {
      clients.delete(c);
    }
  }
}

/**
 * Start the filesystem watchers feeding the SSE clients:
 *  - the **root** directory (the live-watch feature): coalesced `fschange`
 *    events `{changes:[{path,kind}]}` whenever files under root change;
 *  - the **UI assets** (only under `--reload`): `reload` events for hot-reload.
 *
 * Recursive watching can fail on very large trees (inotify limits) — we fail
 * soft: log it and emit a one-time `watcherror` so the UI can show a notice.
 */
function startWatchers(clients: Set<ServerResponse>, config: Config): void {
  // Root watcher — the directory-watch feature. Coalesces a burst of events
  // into one message (~150ms) and skips our own backup dir and .git churn.
  const pending = new Map<string, string>();
  let flushTimer: NodeJS.Timeout | null = null;
  const flush = () => {
    flushTimer = null;
    if (pending.size === 0) return;
    const changes = [...pending].map(([path, kind]) => ({ path, kind }));
    pending.clear();
    broadcast(clients, "fschange", JSON.stringify({ changes }));
    // Persist each change to the observability journal (metadata only — path +
    // op, never contents) and bump the live counter.
    const now = Date.now();
    for (const { path, kind } of changes) {
      metrics?.incr("fschange");
      void journal?.record({ ts: now, kind: "fschange", path, op: kind });
    }
  };
  try {
    watch(config.root, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const rel = filename.toString().split(sep).join("/");
      if (rel === ".git" || rel.startsWith(".git/")) return;
      if (rel === BACKUP_DIR || rel.startsWith(BACKUP_DIR + "/")) return;
      pending.set(rel, eventType); // "rename" (create/delete/move) | "change"
      if (!flushTimer) flushTimer = setTimeout(flush, 150);
    });
    log("info", `watching ${config.root} for changes`);
  } catch (e) {
    const msg = (e as Error).message;
    log("error", `root watcher failed: ${msg}`);
    // Tell clients once they connect (best-effort, slight delay).
    setTimeout(() => broadcast(clients, "watcherror", JSON.stringify({ message: msg })), 500);
  }

  // UI hot-reload watcher (dev only).
  if (config.reload) {
    let t: NodeJS.Timeout | null = null;
    try {
      watch(PUBLIC_DIR, { recursive: true }, () => {
        if (t) clearTimeout(t);
        t = setTimeout(() => broadcast(clients, "reload", "1"), 120);
      });
    } catch (e) {
      log("error", `reload watcher failed: ${(e as Error).message}`);
    }
  }

  // Heartbeat so proxies/clients keep the SSE connection open.
  const beat = setInterval(() => broadcast(clients, "ping", "1"), 30_000);
  beat.unref();
}

/** Send a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

/**
 * Minimal structured-ish logger to stdout, doubling as the observability
 * chokepoint: `audit` and `error` lines are mirrored into the persistent
 * journal and counted in metrics. Audit messages use consistent verb prefixes
 * ("reveal …", "write: …", "restore …"), so the leading verb is also counted
 * as its own metric. Best-effort — a journal/metrics failure never throws here.
 */
function log(level: "info" | "audit" | "error", msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${level}: ${msg}\n`);
  try {
    if (level === "audit") {
      metrics?.incr("audit");
      const verb = msg.split(/[:\s]/, 1)[0];
      if (verb) metrics?.incr(verb);
      void journal?.record({ ts: Date.now(), kind: "audit", msg });
    } else if (level === "error") {
      metrics?.incr("error");
      void journal?.record({ ts: Date.now(), kind: "error", msg });
    }
  } catch {
    /* observability must not break the request path */
  }
}

main();
