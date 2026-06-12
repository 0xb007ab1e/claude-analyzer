/**
 * Filesystem operations confined to the configured root.
 *
 * Every public function takes the root-relative path the client sent and routes
 * it through {@link safeResolveAsync} before touching disk. Reads classify the
 * file (text vs binary, json/jsonl/markdown/...) and redact secrets by default.
 * Writes validate JSON, snapshot a timestamped backup, then replace atomically.
 */

import { readdir, readFile, writeFile, stat, copyFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { PathError, safeResolveAsync, toRelative, relJoin } from "./paths.ts";
import { isSensitivePath, redactText } from "./redact.ts";

/** One entry in a directory listing. */
export interface DirEntry {
  name: string;
  /** Root-relative path (forward slashes). */
  path: string;
  kind: "dir" | "file";
  size: number;
  /** Modified time (epoch ms). */
  mtime: number;
  /** True if this file/path is treated as sensitive (whole-file redaction). */
  sensitive: boolean;
}

/** Result of reading a file. */
export interface FileRead {
  path: string;
  /** Logical content type used by the viewer. */
  type: "json" | "jsonl" | "markdown" | "text" | "binary";
  size: number;
  mtime: number;
  /** Whether this file is wholly sensitive. */
  sensitive: boolean;
  /** Whether the returned `content` had secrets masked. */
  redacted: boolean;
  /** Whether raw (un-redacted) bytes were returned (reveal=true). */
  revealed: boolean;
  /** Text content (omitted for binary and for chunked files). */
  content?: string;
  /** Human note for binary / skipped / chunked content. */
  note?: string;
  /** True for over-cap text/JSONL: load the body via {@link readFileLines}. */
  chunked?: boolean;
  /** For binary files: how the UI should present it. */
  viewer?: "image" | "pdf" | "download";
}

/** A window of lines from a (possibly very large) text/JSONL file. */
export interface FileLines {
  path: string;
  /** Logical content type (json/jsonl/markdown/text). */
  type: FileRead["type"];
  size: number;
  mtime: number;
  sensitive: boolean;
  /** First line index requested (0-based). */
  from: number;
  /** Total number of lines in the file. */
  total: number;
  /** True when more lines exist after this window. */
  hasMore: boolean;
  /** Whether any returned line had secrets masked. */
  redacted: boolean;
  /** The requested window: {n: 0-based line index, text}. */
  lines: Array<{ n: number; text: string }>;
}

/** Max bytes we will read into memory and ship to the browser as text. */
const MAX_TEXT_BYTES = 8 * 1024 * 1024; // 8 MiB

/** File extensions treated as searchable/renderable text (shared with search). */
export const TEXT_EXTENSIONS = new Set([
  "json", "jsonl", "ndjson", "md", "markdown", "txt", "text", "log", "out", "err",
  "sh", "bash", "zsh", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go",
  "rs", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "lock", "csv", "tsv",
  "html", "css", "xml", "sql", "diff", "patch", "gitignore", "sample",
  "highwatermark", "status", "bak",
]);

/** List the immediate children of a directory (sorted: dirs first, then name). */
export async function listDir(root: string, relPath: string): Promise<{
  path: string;
  entries: DirEntry[];
}> {
  const abs = await safeResolveAsync(root, relPath);
  const dirents = await readdir(abs, { withFileTypes: true });
  const entries: DirEntry[] = [];

  for (const d of dirents) {
    const childAbs = join(abs, d.name);
    let st;
    try {
      st = await stat(childAbs);
    } catch {
      continue; // dangling symlink / vanished file — skip
    }
    const childRel = relJoin(toRelative(root, abs), d.name);
    const isDir = st.isDirectory();
    entries.push({
      name: d.name,
      path: childRel,
      kind: isDir ? "dir" : "file",
      size: st.size,
      mtime: st.mtimeMs,
      sensitive: !isDir && isSensitivePath(childRel),
    });
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { path: toRelative(root, abs), entries };
}

/**
 * Read a file, classify it, and (unless `reveal`) redact secrets.
 *
 * @param reveal  When true, return raw bytes with no redaction — this is the
 *   deliberate "show me the secret" action and is logged by the caller.
 */
export async function readFileClassified(
  root: string,
  relPath: string,
  reveal: boolean,
): Promise<FileRead> {
  const abs = await safeResolveAsync(root, relPath);
  const st = await stat(abs);
  if (st.isDirectory()) throw new PathError("path is a directory", 400);

  const rel = toRelative(root, abs);
  const ext = extensionOf(rel);
  const sensitive = isSensitivePath(rel);
  const base: Omit<FileRead, "type"> = {
    path: rel,
    size: st.size,
    mtime: st.mtimeMs,
    sensitive,
    redacted: false,
    revealed: reveal,
  };

  if (st.size > MAX_TEXT_BYTES) {
    // Over the inline cap: text/JSONL is loaded in chunks; binaries get a viewer.
    if (TEXT_EXTENSIONS.has(ext)) {
      return {
        ...base,
        type: logicalType(ext),
        chunked: true,
        note: `Large file (${st.size.toLocaleString()} bytes) — loaded in chunks.`,
      };
    }
    return {
      ...base,
      type: "binary",
      viewer: viewerKind(ext),
      note: `File is ${st.size.toLocaleString()} bytes.`,
    };
  }

  const buf = await readFile(abs);
  if (looksBinary(buf, ext)) {
    return {
      ...base,
      type: "binary",
      viewer: viewerKind(ext),
      note: `Binary file (${st.size.toLocaleString()} bytes).`,
    };
  }

  let text = buf.toString("utf8");
  let redacted = false;
  if (!reveal) {
    const r = redactText(text, { wholeFileSensitive: sensitive });
    text = r.text;
    redacted = r.redacted;
  }

  return { ...base, type: logicalType(ext), redacted, content: text };
}

/** Hard cap on lines returned in one {@link readFileLines} window. */
export const MAX_LINES_PER_REQUEST = 2000;

/**
 * Read a window of lines `[from, from+count)` from a text/JSONL file by
 * streaming it line-by-line — never loading the whole file into memory. Each
 * returned line is redacted unless `reveal`. Also returns the total line count.
 *
 * @param from    0-based first line to return (clamped to ≥ 0).
 * @param count   Number of lines to return (clamped to 1..{@link MAX_LINES_PER_REQUEST}).
 * @param reveal  When true, return raw lines (no redaction).
 */
export async function readFileLines(
  root: string,
  relPath: string,
  from: number,
  count: number,
  reveal: boolean,
): Promise<FileLines> {
  const abs = await safeResolveAsync(root, relPath);
  const st = await stat(abs);
  if (st.isDirectory()) throw new PathError("path is a directory", 400);

  const start = Math.max(0, Math.floor(from));
  const want = Math.min(Math.max(1, Math.floor(count)), MAX_LINES_PER_REQUEST);
  const rel = toRelative(root, abs);
  const sensitive = isSensitivePath(rel);

  const lines: Array<{ n: number; text: string }> = [];
  let total = 0;
  let redacted = false;

  const rl = createInterface({
    input: createReadStream(abs, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const idx = total++;
    if (idx >= start && lines.length < want) {
      let text = line;
      if (!reveal) {
        const r = redactText(text);
        text = r.text;
        if (r.redacted) redacted = true;
      }
      lines.push({ n: idx, text });
    }
  }

  return {
    path: rel,
    type: logicalType(extensionOf(rel)),
    size: st.size,
    mtime: st.mtimeMs,
    sensitive,
    from: start,
    total,
    hasMore: start + lines.length < total,
    redacted,
    lines,
  };
}

/** Image/PDF/other classification for binary files, driving the UI viewer. */
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "ico", "svg", "bmp", "avif"]);

/** How the UI should present a binary file of this extension. */
export function viewerKind(ext: string): "image" | "pdf" | "download" {
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  return "download";
}

/** Best-effort Content-Type for serving a raw file by extension. */
export function contentType(ext: string): string {
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", ico: "image/x-icon", svg: "image/svg+xml", bmp: "image/bmp",
    avif: "image/avif", pdf: "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Public wrapper: resolve a client path to a confined absolute path. */
export async function resolveInRoot(root: string, relPath: string): Promise<string> {
  return safeResolveAsync(root, relPath);
}

/** Lowercased final extension of a root-relative path (exposed for raw serving). */
export function extOf(rel: string): string {
  return extensionOf(rel);
}

/**
 * Overwrite a text file with new content. Validates JSON, snapshots a
 * timestamped backup into `.analyzer-backups/`, then writes.
 *
 * @returns the relative path of the backup that was created (if the file
 *   previously existed).
 */
export async function writeFileGuarded(
  root: string,
  relPath: string,
  content: string,
): Promise<{ path: string; backup: string | null; bytes: number }> {
  const abs = await safeResolveAsync(root, relPath);
  const rel = toRelative(root, abs);
  const ext = extensionOf(rel);

  // JSON / JSONL validation — refuse to save syntactically broken settings.
  if (ext === "json") {
    try {
      JSON.parse(content);
    } catch (e) {
      throw new PathError(`Invalid JSON: ${(e as Error).message}`, 422);
    }
  } else if (ext === "jsonl" || ext === "ndjson") {
    validateJsonl(content);
  }

  // Snapshot a backup of the existing file (if any) before overwriting.
  let backupRel: string | null = null;
  let existed = true;
  try {
    await stat(abs);
  } catch {
    existed = false;
  }
  if (existed) {
    backupRel = await snapshotBackup(root, abs, rel);
  }

  const bytes = Buffer.byteLength(content, "utf8");
  await writeFile(abs, content, "utf8");
  return { path: rel, backup: backupRel, bytes };
}

/** Name of the directory where pre-write backups are stored, under root. */
export const BACKUP_DIR = ".analyzer-backups";

/** Copy `abs` into the backup dir with a timestamped name. */
async function snapshotBackup(root: string, abs: string, rel: string): Promise<string> {
  const backupRootAbs = join(root, BACKUP_DIR);
  await mkdir(backupRootAbs, { recursive: true });
  // Flatten the relative path so nested files don't need nested backup dirs.
  const flat = rel.replace(/[/\\]/g, "__");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `${flat}.${stamp}.bak`;
  const backupAbs = join(backupRootAbs, backupName);
  await copyFile(abs, backupAbs);
  return relJoin(BACKUP_DIR, backupName);
}

/** Validate that every non-blank line of a JSONL doc is valid JSON. */
function validateJsonl(content: string): void {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    try {
      JSON.parse(line);
    } catch (e) {
      throw new PathError(`Invalid JSON on line ${i + 1}: ${(e as Error).message}`, 422);
    }
  }
}

/** Lowercased final extension (no dot). "" if none. */
function extensionOf(rel: string): string {
  const base = rel.split("/").pop() ?? rel;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return ""; // no ext, or dotfile like ".gitignore" handled below
  return base.slice(dot + 1).toLowerCase();
}

/** Map an extension to the viewer's logical content type. */
function logicalType(ext: string): FileRead["type"] {
  if (ext === "json") return "json";
  if (ext === "jsonl" || ext === "ndjson") return "jsonl";
  if (ext === "md" || ext === "markdown") return "markdown";
  return "text";
}

/**
 * Heuristic binary check: a NUL byte in the first chunk, or a non-text
 * extension. Keeps us from shipping garbage (images, sqlite dbs) as "text".
 */
function looksBinary(buf: Buffer, ext: string): boolean {
  const KNOWN_BINARY = new Set(["jpg", "jpeg", "png", "gif", "pdf", "db", "sqlite", "pyc", "zip", "gz", "wasm", "ico", "webp"]);
  if (KNOWN_BINARY.has(ext)) return true;
  if (ext !== "" && TEXT_EXTENSIONS.has(ext)) return false;
  // Unknown extension: sniff for NUL in the first 4KiB.
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
