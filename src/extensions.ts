/**
 * Extensions explorer: gather and parse hooks, agents, skills, commands, and
 * MCP server config from a `.claude` root directory.
 *
 * All filesystem access is confined to `root` via {@link safeResolveAsync}.
 * Secret-looking values are redacted by default (pass `reveal=true` to skip).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { safeResolveAsync, toRelative } from "./paths.ts";
import { parseFrontmatter, type FrontmatterValue } from "./frontmatter.ts";
import { redactText } from "./redact.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One resolved hook entry from the `hooks` block of settings.json. */
export interface HookEntry {
  /** The event name (e.g. "Stop", "PreToolUse"). */
  event: string;
  /** The matcher string (e.g. "*" or "Bash"). */
  matcher: string;
  /**
   * The shell command.  Redacted by default (may contain paths with secrets).
   * Set `reveal=true` on the API call to see raw values.
   */
  command: string;
  /** Whether the command was redacted. */
  redacted: boolean;
}

/** One parsed agent definition file. */
export interface AgentEntry {
  /** Root-relative file path. */
  file: string;
  /** `name` field from frontmatter, or the filename stem. */
  name: string;
  /** `description` field from frontmatter (may be multi-line / folded). */
  description: string;
  /** Full frontmatter object. */
  frontmatter: Record<string, FrontmatterValue>;
  /** First ~200 chars of the body (after the `---` block). */
  bodyPreview: string;
}

/** One parsed skill definition file (from `skills/{name}/SKILL.md`). */
export interface SkillEntry {
  /** Root-relative file path. */
  file: string;
  /** `name` field from frontmatter, or the directory name. */
  name: string;
  /** `description` field from frontmatter. */
  description: string;
  /** Full frontmatter object. */
  frontmatter: Record<string, FrontmatterValue>;
  /** First ~200 chars of the body. */
  bodyPreview: string;
}

/** One parsed slash-command definition file. */
export interface CommandEntry {
  /** Root-relative file path. */
  file: string;
  /** Command name (filename stem). */
  name: string;
  /** `description` field from frontmatter, or empty string. */
  description: string;
  /** Full frontmatter object. */
  frontmatter: Record<string, FrontmatterValue>;
  /** First ~200 chars of the body. */
  bodyPreview: string;
}

/** One MCP server configuration. */
export interface McpEntry {
  /** Server name / key. */
  name: string;
  /** Transport type: "stdio" | "http" | "unknown". */
  transport: string;
  /** Command (for stdio) or URL (for http), redacted if it looks secret. */
  endpoint: string;
  /** Whether the endpoint was redacted. */
  redacted: boolean;
  /** Whether this server needs auth (from mcp-needs-auth-cache.json). */
  needsAuth: boolean;
  /** Source file where this server was found. */
  source: string;
}

/** Full result of {@link gatherExtensions}. */
export interface ExtensionsResult {
  hooks: HookEntry[];
  agents: AgentEntry[];
  skills: SkillEntry[];
  commands: CommandEntry[];
  mcp: McpEntry[];
  counts: {
    hooks: number;
    agents: number;
    skills: number;
    commands: number;
    mcp: number;
  };
}

// ---------------------------------------------------------------------------
// Limits (prevent unbounded reads)
// ---------------------------------------------------------------------------

const MAX_AGENTS = 100;
const MAX_SKILLS = 100;
const MAX_COMMANDS = 100;
const MAX_FILE_BYTES = 128 * 1024; // 128 KiB per markdown file
const BODY_PREVIEW_LEN = 200;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Gather all extension data from `root`, redacting secrets unless `reveal`.
 *
 * @param root    Absolute, realpath'd root directory (the `.claude` dir).
 * @param reveal  When true, return un-redacted command strings.
 */
export async function gatherExtensions(root: string, reveal: boolean): Promise<ExtensionsResult> {
  const [hooks, agents, skills, commands, mcp] = await Promise.all([
    gatherHooks(root, reveal),
    gatherAgents(root),
    gatherSkills(root),
    gatherCommands(root),
    gatherMcp(root, reveal),
  ]);
  return {
    hooks,
    agents,
    skills,
    commands,
    mcp,
    counts: {
      hooks: hooks.length,
      agents: agents.length,
      skills: skills.length,
      commands: commands.length,
      mcp: mcp.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Read the `hooks` block from `settings.json` (and `settings.local.json` if
 * present), flatten to {@link HookEntry} records.
 */
async function gatherHooks(root: string, reveal: boolean): Promise<HookEntry[]> {
  const entries: HookEntry[] = [];
  for (const filename of ["settings.json", "settings.local.json"]) {
    const parsed = await readJsonFile(root, filename);
    if (!parsed || typeof parsed !== "object") continue;
    const hooks = (parsed as Record<string, unknown>).hooks;
    if (!hooks || typeof hooks !== "object") continue;
    for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
      if (!Array.isArray(matchers)) continue;
      for (const group of matchers) {
        if (!group || typeof group !== "object") continue;
        const g = group as Record<string, unknown>;
        const matcher = typeof g.matcher === "string" ? g.matcher : "*";
        const innerHooks = Array.isArray(g.hooks) ? g.hooks : [];
        for (const h of innerHooks) {
          if (!h || typeof h !== "object") continue;
          const hh = h as Record<string, unknown>;
          const rawCmd = typeof hh.command === "string" ? hh.command : "";
          let command = rawCmd;
          let redacted = false;
          if (!reveal && rawCmd) {
            const r = redactText(rawCmd);
            command = r.text;
            redacted = r.redacted;
          }
          entries.push({ event, matcher, command, redacted });
        }
      }
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Read all `agents/*.md` files and parse their frontmatter. */
async function gatherAgents(root: string): Promise<AgentEntry[]> {
  const entries: AgentEntry[] = [];
  const files = await listMdFiles(root, "agents");
  for (const rel of files.slice(0, MAX_AGENTS)) {
    const text = await readTextFile(root, rel);
    if (text === null) continue;
    const { frontmatter, body } = parseFrontmatter(text);
    const stem = rel.replace(/^agents\//, "").replace(/\.md$/, "");
    const name = asString(frontmatter.name) || stem;
    const description = asString(frontmatter.description) || "";
    entries.push({
      file: rel,
      name,
      description,
      frontmatter,
      bodyPreview: body.trim().slice(0, BODY_PREVIEW_LEN),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** Read all `skills/{name}/SKILL.md` (and `skills/{name}.md`) files. */
async function gatherSkills(root: string): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  const skillsAbs = await safeResolveAsync(root, "skills").catch(() => null);
  if (!skillsAbs) return entries;

  let dirents: import("node:fs").Dirent[];
  try {
    const { readdir: rd } = await import("node:fs/promises");
    dirents = await rd(skillsAbs, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const d of dirents) {
    if (entries.length >= MAX_SKILLS) break;
    if (d.isDirectory()) {
      // `skills/<name>/SKILL.md`
      const rel = `skills/${d.name}/SKILL.md`;
      const text = await readTextFile(root, rel);
      if (text === null) continue;
      const { frontmatter, body } = parseFrontmatter(text);
      const name = asString(frontmatter.name) || d.name;
      const description = asString(frontmatter.description) || "";
      entries.push({
        file: rel,
        name,
        description,
        frontmatter,
        bodyPreview: body.trim().slice(0, BODY_PREVIEW_LEN),
      });
    } else if (d.isFile() && d.name.endsWith(".md")) {
      // `skills/<name>.md` (flat style)
      const rel = `skills/${d.name}`;
      const text = await readTextFile(root, rel);
      if (text === null) continue;
      const { frontmatter, body } = parseFrontmatter(text);
      const stem = d.name.replace(/\.md$/, "");
      const name = asString(frontmatter.name) || stem;
      const description = asString(frontmatter.description) || "";
      entries.push({
        file: rel,
        name,
        description,
        frontmatter,
        bodyPreview: body.trim().slice(0, BODY_PREVIEW_LEN),
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Read all `commands/{name}.md` files (slash commands), if the directory exists. */
async function gatherCommands(root: string): Promise<CommandEntry[]> {
  const entries: CommandEntry[] = [];
  const files = await listMdFiles(root, "commands");
  for (const rel of files.slice(0, MAX_COMMANDS)) {
    const text = await readTextFile(root, rel);
    if (text === null) continue;
    const { frontmatter, body } = parseFrontmatter(text);
    const stem = rel.replace(/^commands\//, "").replace(/\.md$/, "");
    const name = asString(frontmatter.name) || stem;
    const description = asString(frontmatter.description) || "";
    entries.push({
      file: rel,
      name,
      description,
      frontmatter,
      bodyPreview: body.trim().slice(0, BODY_PREVIEW_LEN),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/**
 * Gather MCP server configs from `.mcp.json`, `mcp.json`, and `mcpServers` in
 * `settings.json`.  Cross-references `mcp-needs-auth-cache.json`.
 */
async function gatherMcp(root: string, reveal: boolean): Promise<McpEntry[]> {
  const needsAuthMap = await readNeedsAuthCache(root);
  const entries: McpEntry[] = [];
  const seen = new Set<string>();

  // Helper: merge entries from a parsed JSON object that contains `mcpServers`.
  const mergeServers = (obj: unknown, source: string) => {
    if (!obj || typeof obj !== "object") return;
    const servers = (obj as Record<string, unknown>).mcpServers;
    if (!servers || typeof servers !== "object") return;
    for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
      if (seen.has(name)) continue;
      seen.add(name);
      entries.push(parseMcpEntry(name, cfg, source, needsAuthMap, reveal));
    }
  };

  // 1. `.mcp.json`
  const dotMcp = await readJsonFile(root, ".mcp.json");
  if (dotMcp) mergeServers(dotMcp, ".mcp.json");

  // 2. `mcp.json`
  const mcpJson = await readJsonFile(root, "mcp.json");
  if (mcpJson) mergeServers(mcpJson, "mcp.json");

  // 3. `settings.json`
  const settings = await readJsonFile(root, "settings.json");
  if (settings) mergeServers(settings, "settings.json");

  // 4. `settings.local.json`
  const settingsLocal = await readJsonFile(root, "settings.local.json");
  if (settingsLocal) mergeServers(settingsLocal, "settings.local.json");

  return entries;
}

/** Build a map of `server-name → true` from `mcp-needs-auth-cache.json`. */
async function readNeedsAuthCache(root: string): Promise<Set<string>> {
  const parsed = await readJsonFile(root, "mcp-needs-auth-cache.json");
  if (!parsed || typeof parsed !== "object") return new Set();
  return new Set(Object.keys(parsed as Record<string, unknown>));
}

/** Parse one MCP server config object into an {@link McpEntry}. */
function parseMcpEntry(
  name: string,
  cfg: unknown,
  source: string,
  needsAuthMap: Set<string>,
  reveal: boolean,
): McpEntry {
  if (!cfg || typeof cfg !== "object") {
    return { name, transport: "unknown", endpoint: "", redacted: false, needsAuth: needsAuthMap.has(name), source };
  }
  const c = cfg as Record<string, unknown>;

  // Stdio transport: `command` field (string or array).
  if (c.command !== undefined) {
    const rawCmd = Array.isArray(c.command)
      ? c.command.map(String).join(" ")
      : typeof c.command === "string"
        ? c.command
        : "";
    let endpoint = rawCmd;
    let redacted = false;
    if (!reveal && rawCmd) {
      const r = redactText(rawCmd);
      endpoint = r.text;
      redacted = r.redacted;
    }
    return { name, transport: "stdio", endpoint, redacted, needsAuth: needsAuthMap.has(name), source };
  }

  // HTTP transport: `url` field.
  if (typeof c.url === "string") {
    let endpoint = c.url;
    let redacted = false;
    if (!reveal) {
      const r = redactText(endpoint);
      endpoint = r.text;
      redacted = r.redacted;
    }
    return { name, transport: "http", endpoint, redacted, needsAuth: needsAuthMap.has(name), source };
  }

  return { name, transport: "unknown", endpoint: "", redacted: false, needsAuth: needsAuthMap.has(name), source };
}

// ---------------------------------------------------------------------------
// Filesystem helpers (confined to root)
// ---------------------------------------------------------------------------

/**
 * Read a JSON file from a known safe relative path.
 * Returns `null` if the file does not exist or cannot be parsed.
 */
async function readJsonFile(root: string, rel: string): Promise<unknown> {
  let abs: string;
  try {
    abs = await safeResolveAsync(root, rel);
  } catch {
    return null;
  }
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    return null; // file absent or unreadable
  }
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Read a text file from a known safe relative path.
 * Returns `null` if missing, unreadable, or too large.
 */
async function readTextFile(root: string, rel: string): Promise<string | null> {
  let abs: string;
  try {
    abs = await safeResolveAsync(root, rel);
  } catch {
    return null;
  }
  let st: import("node:fs").Stats;
  try {
    st = await stat(abs);
  } catch {
    return null;
  }
  if (st.size > MAX_FILE_BYTES) return null;
  try {
    return (await readFile(abs)).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * List all `.md` files directly inside `root/<subDir>` (non-recursive).
 * Returns root-relative paths.  Returns `[]` if the directory does not exist.
 */
async function listMdFiles(root: string, subDir: string): Promise<string[]> {
  let abs: string;
  try {
    abs = await safeResolveAsync(root, subDir);
  } catch {
    return [];
  }
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => `${subDir}/${d.name}`);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Safely extract a string from a frontmatter value.
 * Multi-line / folded strings are returned as-is; arrays and objects return "".
 */
function asString(v: FrontmatterValue | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(", ");
  return "";
}
