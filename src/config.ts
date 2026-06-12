/**
 * Runtime configuration: resolves the `.claude` root, host, and port.
 *
 * Resolution order for the root directory (first that is set wins):
 *   1. `--root <dir>` CLI flag
 *   2. `CLAUDE_DIR` environment variable
 *   3. `<home>/.claude` (the default)
 *
 * The root is realpath'd at startup; if it doesn't exist we fail fast with a
 * clear message rather than booting onto a non-existent directory.
 */

import { realpathSync, statSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Loopback host names always accepted in the Host header. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

/**
 * Auto-detect the Claude Code source repository for the xref feature, without
 * baking in any machine-specific path. Probes a few conventional locations
 * relative to this app and the user's home; the first existing directory wins.
 * Returns `null` if none are found — the feature then stays off until the user
 * supplies `--source <dir>` or `CLAUDE_SRC`.
 *
 * @param env  Environment (for `HOME`).
 */
function detectSourceDir(env: NodeJS.ProcessEnv): string | null {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const home = env.HOME ?? homedir();
  const candidates = [
    join(repoRoot, "..", "claude", "claude-code"), // sibling "claude/claude-code"
    join(repoRoot, "..", "claude-code"), // sibling "claude-code"
    join(home, "claude-code"),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      // not present — try the next candidate
    }
  }
  return null;
}

/** Fully-resolved, validated runtime configuration. */
export interface Config {
  /** Absolute, realpath'd root directory the app is confined to. */
  root: string;
  /** Bind address. Defaults to loopback; use 0.0.0.0 to reach it by hostname. */
  host: string;
  /** TCP port. */
  port: number;
  /** When false, writes are rejected (browse-only mode). */
  allowWrite: boolean;
  /**
   * Host header values accepted by the server (anti-DNS-rebinding allowlist).
   * Always includes loopback + the machine hostname; extend with --allow-host.
   */
  allowedHosts: string[];
  /** When true, serve the live-reload SSE endpoint and tell the UI to use it. */
  reload: boolean;
  /**
   * Absolute, realpath'd path to the Claude Code source repository used by the
   * source cross-reference feature (`/api/xref`). `null` when not configured or
   * the directory doesn't exist — the feature degrades gracefully.
   *
   * Resolved from `--source <dir>`, then `CLAUDE_SRC`, then auto-detected from a
   * few conventional locations (see {@link detectSourceDir}); `null` if none.
   */
  sourceDir: string | null;
  /**
   * Optional bearer token required on every `/api/*` request (defense in depth
   * for non-loopback binds). `null` disables auth (the default). Resolved from
   * `CA_TOKEN` (preferred), `--token-file <path>`, or `--token <value>`.
   */
  token: string | null;
}

/** A configuration problem that should stop startup with a friendly message. */
export class ConfigError extends Error {}

/**
 * Build {@link Config} from argv + env.
 *
 * @param argv  Process arguments (typically `process.argv.slice(2)`).
 * @param env   Environment (defaults to `process.env`).
 */
export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const flags = parseFlags(argv);

  const rawRoot =
    flags.root ?? env.CLAUDE_DIR ?? join(env.HOME ?? homedir(), ".claude");
  const root = validateRoot(rawRoot);

  const host = flags.host ?? env.HOST ?? "127.0.0.1";
  const port = parsePort(flags.port ?? env.PORT ?? "4317");
  const allowWrite = flags.readOnly ? false : true;
  const reload = flags.noReload ? false : true;
  const allowedHosts = buildAllowedHosts(host, flags.allowHost, env.ALLOW_HOST);

  const rawSource = flags.source ?? env.CLAUDE_SRC ?? detectSourceDir(env);
  const sourceDir = rawSource ? validateSourceDir(rawSource) : null;

  const token = resolveToken(flags, env);

  return { root, host, port, allowWrite, allowedHosts, reload, sourceDir, token };
}

/**
 * Resolve the optional API token. Precedence: `CA_TOKEN` env (preferred — not
 * visible in process listings), then `--token-file <path>` (read + trimmed),
 * then `--token <value>` (convenience; visible in `ps`/shell history, so a
 * warning is emitted by the caller). An empty/whitespace value disables auth.
 *
 * @throws ConfigError if `--token-file` is given but cannot be read.
 */
function resolveToken(flags: ParsedFlags, env: NodeJS.ProcessEnv): string | null {
  let raw: string | undefined = env.CA_TOKEN;
  if (raw === undefined && flags.tokenFile !== undefined) {
    try {
      raw = readFileSync(flags.tokenFile, "utf8");
    } catch {
      throw new ConfigError(`Cannot read --token-file: ${flags.tokenFile}`);
    }
  }
  if (raw === undefined) raw = flags.token;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Build the Host-header allowlist. Loopback names and the machine hostname are
 * always allowed; the bind host (if non-loopback) and any --allow-host /
 * ALLOW_HOST values are added. Ports are stripped; matching is case-insensitive.
 */
function buildAllowedHosts(
  host: string,
  flagHosts: string[],
  envHosts: string | undefined,
): string[] {
  const set = new Set<string>(LOOPBACK_HOSTS);
  const add = (h: string) => {
    const name = h.trim().toLowerCase().split(":")[0];
    if (name) {
      set.add(name);
      // Also allow the short label of an FQDN (e.g. "parrot" from "parrot.local").
      const short = name.split(".")[0];
      if (short) set.add(short);
    }
  };
  add(hostname()); // the machine's own name, e.g. "parrot"
  if (host !== "0.0.0.0" && host !== "::") add(host);
  for (const h of flagHosts) add(h);
  if (envHosts) for (const h of envHosts.split(",")) add(h);
  return [...set];
}

/**
 * Attempt to resolve and validate the source directory for the xref feature.
 * Unlike {@link validateRoot}, this is **non-fatal**: if the path doesn't exist
 * or isn't a directory, we return `null` and let the feature degrade gracefully
 * rather than refusing to start.
 *
 * @param raw  Raw path string from flags or env.
 * @returns  Realpath'd absolute path, or `null` if unreachable.
 */
function validateSourceDir(raw: string): string | null {
  try {
    const abs = resolve(raw);
    const real = realpathSync(abs);
    if (!statSync(real).isDirectory()) return null;
    return real;
  } catch {
    return null;
  }
}

/** Resolve and verify the root is an existing directory. */
function validateRoot(raw: string): string {
  const abs = resolve(raw);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new ConfigError(
      `Root directory does not exist: ${abs}\n` +
        `Pass --root <dir>, set CLAUDE_DIR, or create the directory.`,
    );
  }
  if (!statSync(real).isDirectory()) {
    throw new ConfigError(`Root is not a directory: ${real}`);
  }
  return real;
}

/** Parse `--port`-style flags into a small record. */
interface ParsedFlags {
  root?: string;
  host?: string;
  port?: string;
  readOnly?: boolean;
  noReload?: boolean;
  allowHost: string[];
  /** Path to the Claude Code source tree for the xref feature. */
  source?: string;
  /** Inline API token (convenience; prefer CA_TOKEN). */
  token?: string;
  /** Path to a file containing the API token. */
  tokenFile?: string;
}

function parseFlags(argv: string[]): ParsedFlags {
  const out: ParsedFlags = { allowHost: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--root":
        out.root = requireValue(argv, ++i, "--root");
        break;
      case "--host":
        out.host = requireValue(argv, ++i, "--host");
        break;
      case "--port":
        out.port = requireValue(argv, ++i, "--port");
        break;
      case "--allow-host":
        out.allowHost.push(requireValue(argv, ++i, "--allow-host"));
        break;
      case "--read-only":
      case "--readonly":
        out.readOnly = true;
        break;
      case "--no-reload":
        out.noReload = true;
        break;
      case "--reload":
        out.noReload = false;
        break;
      case "--source":
        out.source = requireValue(argv, ++i, "--source");
        break;
      case "--token":
        out.token = requireValue(argv, ++i, "--token");
        break;
      case "--token-file":
        out.tokenFile = requireValue(argv, ++i, "--token-file");
        break;
      default:
        if (a?.startsWith("--root=")) out.root = a.slice("--root=".length);
        else if (a?.startsWith("--host=")) out.host = a.slice("--host=".length);
        else if (a?.startsWith("--port=")) out.port = a.slice("--port=".length);
        else if (a?.startsWith("--allow-host=")) out.allowHost.push(a.slice("--allow-host=".length));
        else if (a?.startsWith("--source=")) out.source = a.slice("--source=".length);
        else if (a?.startsWith("--token=")) out.token = a.slice("--token=".length);
        else if (a?.startsWith("--token-file=")) out.tokenFile = a.slice("--token-file=".length);
    }
  }
  return out;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) throw new ConfigError(`${flag} requires a value`);
  return v;
}

function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(`Invalid port: ${raw}`);
  }
  return n;
}
