/**
 * Source cross-reference: find occurrences of a token in a source tree.
 *
 * Walks a directory tree recursively, skipping well-known non-source directories
 * (node_modules, .git, dist, build) and binary / oversized files. For each text
 * file it finds, it returns the line numbers and trimmed text of every line that
 * contains the token as a plain substring.
 *
 * SECURITY: the root must already be a validated, realpath'd absolute path; all
 * directory traversal here stays inside it via the {@link isInsideRoot} guard.
 * The token is always treated as a literal substring — never a regex.
 */

import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { join, relative, sep, resolve } from "node:path";

/** A single matched line in a file. */
export interface XrefHit {
  /** 1-based line number. */
  line: number;
  /** The matched line, trimmed to at most {@link MAX_HIT_TEXT} characters. */
  text: string;
}

/** All matches from one file. */
export interface XrefFileResult {
  /** Path relative to the source root (forward slashes). */
  file: string;
  /** Matching lines, in source order. */
  hits: XrefHit[];
}

/** Result returned by {@link searchTree}. */
export interface XrefResult {
  /** Matched files, each with their line hits. */
  matches: XrefFileResult[];
  /** Total number of individual line hits across all files. */
  totalMatches: number;
  /** True when results were capped at the configured limit. */
  truncated: boolean;
  /** Whether the feature is available (source dir configured + accessible). */
  available: true;
}

/** Returned when the source dir is not configured or unreachable. */
export interface XrefUnavailable {
  available: false;
  message: string;
}

/** Limits that callers can tune; defaults keep responses bounded. */
export interface XrefLimits {
  /** Maximum total individual line hits before truncation. Defaults to 100. */
  maxHits?: number;
  /** Maximum file size in bytes to read. Defaults to 1 MiB. */
  maxFileBytes?: number;
  /** Maximum trimmed length of a single hit line. Defaults to 200. */
  maxHitText?: number;
}

const MAX_HIT_TEXT = 200;
const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MiB
const MAX_HITS = 100;

/**
 * Directories to skip during the walk. These tend to be large, generated,
 * or not meaningful for cross-referencing source.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".cache",
  ".next",
  ".nuxt",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "target", // Rust/Maven
  ".tox",
]);

/**
 * File extensions that are almost always plain text and worth searching.
 * Files whose extension isn't in this set (or have no extension) are sniffed
 * for NUL bytes; if any are found they're skipped as binary.
 */
const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "mjs", "cjs", "jsx",
  "py", "rb", "go", "rs", "java", "kt", "scala", "swift", "cs", "cpp", "c", "h", "hpp",
  "sh", "bash", "zsh", "fish",
  "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "md", "txt", "log", "rst", "org",
  "html", "css", "scss", "less",
  "sql", "graphql", "gql",
  "xml", "svg",
  "lock", "mod", "sum",
  "gradle", "pom",
  "tf", "tfvars",
  "dockerfile",
  "makefile", "rakefile", "gemfile",
  "gitignore", "gitattributes", "gitmodules",
]);

/** Extensions that are definitely binary — skip without sniffing. */
const BINARY_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "ico", "svg.gz",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "zip", "gz", "bz2", "xz", "tar", "rar", "7z",
  "db", "sqlite", "sqlite3",
  "pyc", "pyo", "class", "jar", "war", "ear",
  "wasm", "so", "dylib", "dll", "exe", "lib", "a",
  "bin", "dat", "img",
  "mp3", "mp4", "ogg", "wav", "avi", "mov", "mkv",
  "ttf", "otf", "woff", "woff2",
  "npy", "npz", "pkl", "pt", "pth",
]);

/**
 * Verify that `child` (absolute, normalized) stays inside `root`. This is the
 * confinement guard for the recursive walk — prevents a symlink from leading
 * us outside the configured source directory.
 */
function isInsideRoot(root: string, child: string): boolean {
  if (child === root) return true;
  // Ensure we compare with a trailing separator to avoid /a/bc matching /a/b.
  const prefix = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(prefix);
}

/**
 * Return the lowercased extension of a filename, without the dot. Empty string
 * if the file has no extension or is a dotfile like `.gitignore`.
 */
function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Return true if the buffer looks like binary content. Checks the first 4 KiB
 * for NUL bytes, which is a reliable heuristic for non-UTF-8 binary data.
 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Search `sourceRoot` for files containing `token` as a literal substring.
 *
 * @param sourceRoot  Absolute, realpath'd path to the source tree to search.
 *   Must already be validated; this function only enforces containment during
 *   the walk (symlink safety), it does not re-resolve it.
 * @param token  Literal substring to search for. Path separators and whitespace
 *   are allowed (they come from a basename, which has already been sanitised by
 *   the caller). The search is case-sensitive.
 * @param limits  Optional tuning knobs (caps on hit count, file size, line length).
 * @returns  A structured result with matched files and truncation info.
 */
export async function searchTree(
  sourceRoot: string,
  token: string,
  limits: XrefLimits = {},
): Promise<XrefResult> {
  const maxHits = limits.maxHits ?? MAX_HITS;
  const maxFileBytes = limits.maxFileBytes ?? MAX_FILE_BYTES;
  const maxHitText = limits.maxHitText ?? MAX_HIT_TEXT;

  const matches: XrefFileResult[] = [];
  let totalMatches = 0;
  let truncated = false;

  /**
   * Recursive walk. We collect paths from readdir before recursing to keep the
   * stack shallow and avoid opening too many directory handles at once.
   */
  async function walk(dir: string): Promise<void> {
    if (truncated) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip silently
    }

    for (const entry of entries) {
      if (truncated) break;

      const abs = join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        // Resolve the symlink's real path and check it stays inside the root.
        // If realpath fails (dangling symlink) or escapes the root, skip it.
        let real: string;
        try {
          real = await realpath(abs);
        } catch {
          continue; // dangling symlink
        }
        if (!isInsideRoot(sourceRoot, real)) continue;
        // For a symlinked directory, recurse; for a file, fall through to search.
        if (await isDir(abs)) {
          if (SKIP_DIRS.has(entry.name)) continue;
          await walk(abs);
          continue;
        }
        // Fall through: treat the symlinked file like a regular file.
      } else if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(abs);
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue;

      const ext = extOf(entry.name);
      if (BINARY_EXTENSIONS.has(ext)) continue;

      // Size check.
      let fileSize: number;
      try {
        const st = await stat(abs);
        fileSize = st.size;
      } catch {
        continue;
      }
      if (fileSize > maxFileBytes) continue;

      // Read and search.
      let buf: Buffer;
      try {
        buf = await readFile(abs);
      } catch {
        continue;
      }

      // Unknown extension — sniff for binary.
      if (!TEXT_EXTENSIONS.has(ext) && looksBinary(buf)) continue;

      const text = buf.toString("utf8");
      const lines = text.split("\n");
      const fileHits: XrefHit[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.includes(token)) {
          const trimmed = line.trim();
          fileHits.push({
            line: i + 1,
            text: trimmed.length > maxHitText ? trimmed.slice(0, maxHitText) + "…" : trimmed,
          });
          totalMatches++;
          if (totalMatches >= maxHits) {
            truncated = true;
            break;
          }
        }
      }

      if (fileHits.length > 0) {
        const rel = relative(sourceRoot, abs).split(sep).join("/");
        matches.push({ file: rel, hits: fileHits });
      }

      if (truncated) break;
    }
  }

  await walk(sourceRoot);

  return { matches, totalMatches, truncated, available: true };
}

/** Return true if `p` is (or resolves to) a directory; false otherwise. */
async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
