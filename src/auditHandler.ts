/**
 * Security-audit filesystem walker and report assembler.
 *
 * This module performs the bounded tree-walk over the configured root and
 * assembles the three audit sections (exposure, permissions, retention).
 * Pure helpers live in {@link audit.ts} so they can be unit-tested without
 * any I/O setup; this module owns all the `fs/promises` calls.
 *
 * Design constraints:
 *  - Walk is strictly confined to the configured root (uses `join` only from
 *    a known-good absolute path, never user-supplied components).
 *  - Hard caps: 20 000 files and 1 MiB per text file to bound memory and
 *    response time on large trees.
 *  - Raw secret values are NEVER included in the output.  Only masked
 *    snippets (output of `redactText`) and hit counts travel to the client.
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isSensitivePath, redactText } from "./redact.ts";
import {
  countMaskHits,
  firstMaskedSnippet,
  isGroupOrWorldReadable,
  modeToOctal,
  summarizeSizes,
  classifyStale,
} from "./audit.ts";

/** Max number of files the walk will visit before setting `truncated: true`. */
const MAX_FILES = 20_000;

/** Max bytes read from a single text file for secret-scanning. */
const MAX_SCAN_BYTES = 1 * 1024 * 1024; // 1 MiB

/** Top-N largest files to include in the retention section. */
const TOP_N_LARGEST = 20;

// ---------------------------------------------------------------------------
// Public return types
// ---------------------------------------------------------------------------

/** One entry in the secret-exposure section. */
export interface ExposureEntry {
  /** Root-relative path of the file. */
  path: string;
  /**
   * Number of masked tokens found.  Derived by counting `«redacted»` in the
   * redacted text — never derived from the raw secret value.
   */
  hitCount: number;
  /**
   * A single masked line snippet from the file, or `""`.  Contains only
   * `«redacted»` placeholders — raw values are never included.
   */
  sample: string;
  /** True when `isSensitivePath` flagged this file as wholly sensitive. */
  sensitivePath: boolean;
}

/** One entry in the permissions section. */
export interface PermissionEntry {
  /** Root-relative path. */
  path: string;
  /** Human-readable octal mode string, e.g. `"0644"`. */
  mode: string;
  /** True when any group or world permission bit is set. */
  groupOrWorldReadable: boolean;
}

/** Size/age entry in the retention section. */
export interface RetentionFile {
  /** Root-relative path. */
  path: string;
  /** File size in bytes. */
  bytes: number;
  /** Age in whole days (floor). */
  ageDays: number;
  /** Advisory suggestion string. */
  suggestion: string;
}

/** Per-top-level-directory byte totals. */
export interface DirBytes {
  /** Top-level directory name, or `""` for root-level files. */
  dir: string;
  /** Total bytes of all files directly or transitively under this directory. */
  bytes: number;
}

/** The complete audit report returned by {@link runAudit}. */
export interface AuditReport {
  /** Files with detected secret-shaped content (sorted by hitCount desc). */
  exposure: ExposureEntry[];
  /**
   * Sensitive files (by path or exposure) that also have group/world
   * permission bits set.
   */
  permissions: PermissionEntry[];
  retention: {
    /** Total bytes of all visited files. */
    totalBytes: number;
    /** Bytes per top-level directory, sorted descending. */
    byDir: DirBytes[];
    /** Top-{@link TOP_N_LARGEST} largest files, sorted descending. */
    largest: { path: string; bytes: number }[];
    /**
     * Files that match a known-reclaimable pattern or are older than 90 days,
     * with an advisory suggestion.
     */
    stale: RetentionFile[];
  };
  /** How many files were visited. */
  fileCount: number;
  /** True when the walk hit {@link MAX_FILES} and stopped early. */
  truncated: boolean;
  /** ISO-8601 timestamp of when this report was generated. */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

/** Directories to skip entirely during the walk. */
const SKIP_DIRS = new Set<string>([".git", "node_modules"]);

/** Binary-file extensions that we skip for secret scanning (NUL bytes etc.). */
const BINARY_EXTENSIONS = new Set<string>([
  "jpg", "jpeg", "png", "gif", "pdf", "db", "sqlite", "pyc",
  "zip", "gz", "wasm", "ico", "webp", "bin", "exe",
]);

/** Return true when the extension suggests the file is binary. */
function looksLikeTextByExtension(relPath: string): boolean {
  const base = relPath.split("/").pop() ?? relPath;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (BINARY_EXTENSIONS.has(ext)) return false;
  // Unknown or text-ish extension → attempt to scan.
  return true;
}

/** One collected record about a visited file. */
interface FileRecord {
  rel: string;
  bytes: number;
  mode: number;
  ageDays: number;
}

/**
 * Walk the directory tree rooted at `root`, collecting metadata for each file.
 * Stops once {@link MAX_FILES} files have been visited (sets `truncated`).
 *
 * The walk never follows symlinks beyond the root and skips `.git`,
 * `node_modules`, and other noise directories.
 *
 * @param root    Absolute path of the configured root (must already be real).
 * @returns       `{records, truncated}`
 */
async function walkTree(
  root: string,
): Promise<{ records: FileRecord[]; truncated: boolean }> {
  const records: FileRecord[] = [];
  let truncated = false;
  const nowMs = Date.now();

  /**
   * Recursive DFS.  `absDir` is an absolute path we have already confirmed
   * lives inside `root`.  `relDir` is the root-relative counterpart.
   */
  async function visit(absDir: string, relDir: string): Promise<void> {
    if (truncated) return;

    let dirents;
    try {
      dirents = await readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip silently
    }

    for (const d of dirents) {
      if (truncated) return;

      const name = d.name;
      const absChild = join(absDir, name);
      const relChild = relDir === "" ? name : `${relDir}/${name}`;

      if (d.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await visit(absChild, relChild);
      } else if (d.isFile()) {
        if (records.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        let st;
        try {
          st = await stat(absChild);
        } catch {
          continue; // vanished / permission denied
        }
        const ageDays = (nowMs - st.mtimeMs) / (1000 * 60 * 60 * 24);
        records.push({
          rel: relChild,
          bytes: st.size,
          mode: st.mode,
          ageDays,
        });
      }
      // Symlinks: skip entirely — we don't want to scan outside the root and
      // the tree-walker in paths.ts already handles symlink confinement for
      // file reads; audit is advisory so skipping is the safe choice.
    }
  }

  await visit(root, "");
  return { records, truncated };
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

/**
 * Run the full security audit for the configured root directory.
 *
 * Walks the tree (bounded), then in a single pass:
 *  (a) scans each text file for secret-shaped content via `redactText`;
 *  (b) checks file permission modes;
 *  (c) collects size and age data for the retention advisor.
 *
 * Raw secret values are never placed in the returned report — only masked
 * snippets and hit counts.
 *
 * @param root  Absolute, realpath-resolved root directory.
 * @returns     Fully populated {@link AuditReport}.
 */
export async function runAudit(root: string): Promise<AuditReport> {
  const { records, truncated } = await walkTree(root);

  const exposure: ExposureEntry[] = [];
  const permissions: PermissionEntry[] = [];

  // Used for retention section.
  const sizeMap = new Map<string, number>();
  const stale: RetentionFile[] = [];
  let totalBytes = 0;

  // Track which paths ended up in the exposure list for the permission check.
  const exposedPaths = new Set<string>();

  for (const rec of records) {
    totalBytes += rec.bytes;
    sizeMap.set(rec.rel, rec.bytes);

    // ---- (a) Secret exposure ----
    const sensitive = isSensitivePath(rec.rel);
    let hitCount = 0;
    let sample = "";

    if (sensitive) {
      // Wholly-sensitive files: flag them with hitCount = 1 as a minimum so
      // they appear in the exposure list even if we can't read or scan them.
      hitCount = 1;
      // Attempt to read and count hits for a more accurate count.
      if (rec.bytes > 0 && rec.bytes <= MAX_SCAN_BYTES && looksLikeTextByExtension(rec.rel)) {
        try {
          const buf = await readFile(join(root, rec.rel));
          // Check for NUL bytes (binary guard).
          const chunk = buf.subarray(0, Math.min(buf.length, 4096));
          const hasBinary = chunk.indexOf(0) !== -1;
          if (!hasBinary) {
            const raw = buf.toString("utf8");
            const { text: redacted } = redactText(raw, { wholeFileSensitive: true });
            const n = countMaskHits(redacted);
            if (n > hitCount) hitCount = n;
            sample = firstMaskedSnippet(redacted);
          }
        } catch {
          // unreadable — keep hitCount = 1
        }
      }
    } else if (rec.bytes > 0 && rec.bytes <= MAX_SCAN_BYTES && looksLikeTextByExtension(rec.rel)) {
      // Non-sensitive by path: scan for inline secret-shaped tokens.
      try {
        const buf = await readFile(join(root, rec.rel));
        const chunk = buf.subarray(0, Math.min(buf.length, 4096));
        const hasBinary = chunk.indexOf(0) !== -1;
        if (!hasBinary) {
          const raw = buf.toString("utf8");
          const { text: redacted, redacted: wasRedacted } = redactText(raw, { wholeFileSensitive: false });
          if (wasRedacted) {
            hitCount = countMaskHits(redacted);
            sample = firstMaskedSnippet(redacted);
          }
        }
      } catch {
        // unreadable — skip
      }
    }

    if (hitCount > 0 || sensitive) {
      exposure.push({ path: rec.rel, hitCount, sample, sensitivePath: sensitive });
      exposedPaths.add(rec.rel);
    }

    // ---- (b) Permissions ----
    // Flag only files that are (sensitive by path OR in the exposure list)
    // AND have group/world readable bits.
    if (isGroupOrWorldReadable(rec.mode) && (sensitive || exposedPaths.has(rec.rel))) {
      permissions.push({
        path: rec.rel,
        mode: modeToOctal(rec.mode),
        groupOrWorldReadable: true,
      });
    }

    // ---- (c) Retention ----
    const suggestion = classifyStale(rec.rel, rec.ageDays);
    if (suggestion !== null) {
      stale.push({ path: rec.rel, bytes: rec.bytes, ageDays: Math.floor(rec.ageDays), suggestion });
    }
  }

  // Sort exposure by hitCount desc.
  exposure.sort((a, b) => b.hitCount - a.hitCount);

  // Sort stale by bytes desc (largest reclaimable first).
  stale.sort((a, b) => b.bytes - a.bytes);

  // Top-N largest files.
  const largest = [...sizeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N_LARGEST)
    .map(([path, bytes]) => ({ path, bytes }));

  // Per-top-level-dir sizes.
  const byDir = summarizeSizes(sizeMap);

  return {
    exposure,
    permissions,
    retention: {
      totalBytes,
      byDir,
      largest,
      stale,
    },
    fileCount: records.length,
    truncated,
    generatedAt: new Date().toISOString(),
  };
}
