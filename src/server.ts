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
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, sep } from "node:path";
import { loadConfig, ConfigError, type Config } from "./config.ts";
import { listDir, readFileClassified, writeFileGuarded, BACKUP_DIR } from "./files.ts";
import { PathError } from "./paths.ts";

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

/** Static file content types. */
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

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

  // Connected SSE clients. The server watches the root and pushes `fschange`
  // events (the live directory-watch feature) to all of them; under --reload it
  // also pushes `reload` events when the UI's own assets change.
  const liveClients = new Set<ServerResponse>();
  startWatchers(liveClients, config);

  const server = createServer((req, res) => {
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

    if (path === "/api/list" && req.method === "GET") {
      const rel = url.searchParams.get("path") ?? "";
      sendJson(res, 200, await listDir(config.root, rel));
      return;
    }

    if (path === "/api/file" && req.method === "GET") {
      const rel = url.searchParams.get("path") ?? "";
      const reveal = url.searchParams.get("reveal") === "1";
      if (reveal) log("audit", `reveal raw content: ${rel}`);
      sendJson(res, 200, await readFileClassified(config.root, rel, reveal));
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

/** Minimal structured-ish logger to stdout. */
function log(level: "info" | "audit" | "error", msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${level}: ${msg}\n`);
}

main();
