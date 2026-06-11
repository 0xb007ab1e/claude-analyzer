/**
 * File-history snapshot reader.
 *
 * Claude Code records edit history under `<root>/file-history/` (physical
 * content files) and `<root>/projects/<project-key>/<session-uuid>.jsonl`
 * (metadata events).  This module scans both, correlates them, and exposes
 * the list and entry APIs consumed by the HTTP server.
 *
 * Data shapes (as observed in the wild):
 *
 *   Physical files:
 *     <root>/file-history/<sessionUUID>/<hash>@v<N>
 *
 *   JSONL events (one JSON object per line):
 *     { type: "file-history-snapshot",
 *       snapshot: {
 *         timestamp: "<ISO8601>",
 *         trackedFileBackups: {
 *           "<relative/path>": {
 *             backupFileName: "<hash>@v<N>" | null,
 *             version: <number>,
 *             backupTime: "<ISO8601>"
 *           }
 *         }
 *       }
 *     }
 *
 * v1 entries have `backupFileName: null` — the snapshot records that the file
 * was tracked from version 1, but no physical backup exists for it; those
 * entries are included in the listing (metadata-only) but cannot be restored.
 *
 * Security: every path access goes through {@link safeResolveAsync}.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { safeResolveAsync, toRelative, isInside } from "./paths.ts";
import { redactText, isSensitivePath } from "./redact.ts";
import { diffLines, type DiffLine } from "./diff.ts";
import { writeFileGuarded } from "./files.ts";
import { PathError } from "./paths.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single snapshot entry as returned by /api/history/list. */
export interface HistorySnapshot {
  /**
   * Opaque ID: `<sessionUUID>/<backupFileName>` for v2+ snapshots,
   * or `<sessionUUID>/null@<targetPath>` for v1 (metadata-only).
   */
  id: string;
  /** Root-relative path of the file that was snapshotted. */
  targetPath: string;
  /** Snapshot time (ISO 8601 string). */
  timestamp: string;
  /** Snapshot version number (1-based). */
  version: number;
  /** UUID of the Claude Code session. */
  sessionId: string;
  /** True when there is a physical backup file to read/restore. */
  hasContent: boolean;
  /** True when the target is a sensitive path (secrets will be redacted). */
  sensitive: boolean;
}

/** Full entry returned by /api/history/entry. */
export interface HistoryEntry {
  id: string;
  targetPath: string;
  timestamp: string;
  version: number;
  sessionId: string;
  sensitive: boolean;
  /** Whether the content was redacted. */
  redacted: boolean;
  /**
   * The snapshot content (the "before" state captured at backup time).
   * Null when `hasContent` is false (v1 metadata-only entry).
   */
  snapshotContent: string | null;
  /**
   * The current on-disk content of the target file (for diff comparison).
   * Null when the file does not exist or could not be read.
   */
  currentContent: string | null;
  /** Diff between snapshotContent and currentContent (empty if either is null). */
  diff: DiffLine[];
  /** Whether the target path is safe to restore (requires snapshotContent). */
  canRestore: boolean;
}

/** Result of a restore operation. */
export interface RestoreResult {
  restoredPath: string;
  backup: string | null;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max snapshots returned in the list endpoint. */
const MAX_SNAPSHOTS = 500;
/** Max bytes read from a history content file. */
const MAX_HISTORY_BYTES = 4 * 1024 * 1024; // 4 MiB
/** Relative path of the directory where Claude stores session content files. */
const HISTORY_DIR = "file-history";
/** Relative path of the directory where Claude stores project JSONL logs. */
const PROJECTS_DIR = "projects";

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * Return a bounded list of history snapshots, newest first.
 *
 * Scans `<root>/projects/**\/*.jsonl` for `file-history-snapshot` events and
 * correlates them with physical files in `<root>/file-history/`.
 *
 * @param root  Absolute, realpath'd root (the `.claude` directory).
 * @param limit Maximum entries to return (default {@link MAX_SNAPSHOTS}).
 */
export async function listHistory(
  root: string,
  limit = MAX_SNAPSHOTS,
): Promise<HistorySnapshot[]> {
  const snapshots: HistorySnapshot[] = [];

  const projectsAbs = join(root, PROJECTS_DIR);
  // If projects/ doesn't exist yet, return empty without error.
  if (!(await dirExists(projectsAbs))) return snapshots;

  // Walk projects/<project-key>/ subdirectories.
  const projectKeys = await safeDirents(projectsAbs);
  for (const pk of projectKeys) {
    if (!pk.isDirectory()) {
      // Handle JSONL files at the top level of projects/ (some Claude versions).
      if (pk.name.endsWith(".jsonl")) {
        const filePath = join(projectsAbs, pk.name);
        await collectFromJsonl(root, filePath, snapshots);
      }
      continue;
    }
    const pkDir = join(projectsAbs, pk.name);
    const jsonlFiles = await safeDirents(pkDir);
    for (const jf of jsonlFiles) {
      if (!jf.name.endsWith(".jsonl")) continue;
      const filePath = join(pkDir, jf.name);
      await collectFromJsonl(root, filePath, snapshots);
    }
  }

  // Sort newest first.
  snapshots.sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    if (tb !== ta) return tb - ta;
    return a.targetPath.localeCompare(b.targetPath);
  });

  return snapshots.slice(0, limit);
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

/**
 * Return the full history entry for a given snapshot ID.
 *
 * The ID format is `<sessionUUID>/<backupFileName>` (e.g.
 * `040c7fb5.../8d6be812...@v2`).  We scan the project JSONL files to locate
 * the matching snapshot rather than trusting the ID as a direct filesystem
 * path, which keeps the access fully mediated.
 *
 * @param root    Absolute, realpath'd root.
 * @param id      Snapshot ID from the list endpoint.
 * @param reveal  When true, return raw content without redaction.
 */
export async function getHistoryEntry(
  root: string,
  id: string,
  reveal: boolean,
): Promise<HistoryEntry> {
  const snapshot = await findSnapshot(root, id);
  if (!snapshot) {
    const e = new PathError("history snapshot not found", 404);
    throw e;
  }

  const sensitive = snapshot.sensitive;

  // Read snapshot content (the physical backup file).
  let snapshotContent: string | null = null;
  let redacted = false;
  if (snapshot.hasContent) {
    const raw = await readHistoryFile(root, snapshot.sessionId, idToBackupFileName(id));
    if (raw !== null) {
      if (!reveal) {
        const r = redactText(raw, { wholeFileSensitive: sensitive });
        snapshotContent = r.text;
        redacted = r.redacted;
      } else {
        snapshotContent = raw;
      }
    }
  }

  // Read the current on-disk version of the target file for comparison.
  let currentContent: string | null = null;
  try {
    const targetAbs = await safeResolveAsync(root, snapshot.targetPath);
    const buf = await readFile(targetAbs);
    if (buf.length <= MAX_HISTORY_BYTES) {
      let text = buf.toString("utf8");
      if (!reveal) {
        const r = redactText(text, { wholeFileSensitive: sensitive });
        text = r.text;
        if (r.redacted) redacted = true;
      }
      currentContent = text;
    }
  } catch {
    // File may not exist on disk any more — that's fine, diff will be partial.
  }

  // Compute diff: snapshot → current ("what changed since this snapshot?").
  const diff =
    snapshotContent !== null && currentContent !== null
      ? diffLines(snapshotContent, currentContent)
      : [];

  return {
    id: snapshot.id,
    targetPath: snapshot.targetPath,
    timestamp: snapshot.timestamp,
    version: snapshot.version,
    sessionId: snapshot.sessionId,
    sensitive,
    redacted,
    snapshotContent,
    currentContent,
    diff,
    canRestore: snapshot.hasContent && snapshotContent !== null,
  };
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

/**
 * Restore a snapshot's content to the target file.
 *
 * Requires `config.allowWrite`; the caller is responsible for checking that
 * before calling.  Delegates to {@link writeFileGuarded} which makes a
 * timestamped backup of the current file before overwriting.
 *
 * Only v2+ snapshots (those with a physical backup file) can be restored.
 */
export async function restoreHistoryEntry(
  root: string,
  id: string,
): Promise<RestoreResult> {
  const snapshot = await findSnapshot(root, id);
  if (!snapshot) throw new PathError("history snapshot not found", 404);
  if (!snapshot.hasContent) {
    throw new PathError(
      "snapshot has no stored content (version 1) — restore is not possible",
      422,
    );
  }

  const raw = await readHistoryFile(root, snapshot.sessionId, idToBackupFileName(id));
  if (raw === null) {
    throw new PathError("snapshot content file not found or too large", 404);
  }

  const result = await writeFileGuarded(root, snapshot.targetPath, raw);
  return {
    restoredPath: result.path,
    backup: result.backup,
    bytes: result.bytes,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the backup file name from a snapshot ID.
 * IDs are `<sessionUUID>/<backupFileName>`.
 */
function idToBackupFileName(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

/** Build a snapshot ID from session UUID and backup file name. */
function buildId(sessionId: string, backupFileName: string | null, targetPath: string): string {
  if (backupFileName) return `${sessionId}/${backupFileName}`;
  // v1 entries have no backup file; encode target path so the ID is stable.
  const safe = targetPath.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${sessionId}/null@${safe}`;
}

/** Validate that an ID looks reasonable (no traversal characters). */
function isValidId(id: string): boolean {
  // Allow UUID chars, @, v, digits, forward slash, underscore, dot, hyphen.
  // Must contain exactly one slash separating session UUID from backup name.
  if (typeof id !== "string" || id.length === 0 || id.length > 256) return false;
  if (/[^a-zA-Z0-9@._/\-]/.test(id)) return false;
  const slash = id.indexOf("/");
  if (slash < 1 || slash === id.length - 1) return false;
  if (id.indexOf("/", slash + 1) !== -1) return false; // more than one slash
  return true;
}

/**
 * Scan a JSONL file for `file-history-snapshot` events and append to `out`.
 * Errors reading individual lines are silently skipped (corrupt/partial writes).
 */
async function collectFromJsonl(
  root: string,
  filePath: string,
  out: HistorySnapshot[],
): Promise<void> {
  let raw: string;
  try {
    const buf = await readFile(filePath);
    raw = buf.toString("utf8");
  } catch {
    return; // file vanished or permission error
  }

  // Derive the session UUID from the JSONL file name (strip .jsonl extension).
  const fileName = filePath.split("/").pop() ?? "";
  const sessionId = fileName.endsWith(".jsonl") ? fileName.slice(0, -6) : fileName;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isHistorySnapshotEvent(obj)) continue;

    const { snapshot } = obj;
    const timestamp = snapshot.timestamp;
    const backups = snapshot.trackedFileBackups;

    for (const [targetPath, backup] of Object.entries(backups)) {
      const { backupFileName, version } = backup;
      const hasContent = backupFileName !== null && backupFileName !== undefined;
      out.push({
        id: buildId(sessionId, backupFileName ?? null, targetPath),
        targetPath,
        timestamp: backup.backupTime ?? timestamp,
        version,
        sessionId,
        hasContent,
        sensitive: isSensitivePath(targetPath),
      });
    }
  }
}

/**
 * Search all project JSONL files for the snapshot matching `id`.
 * Returns the snapshot metadata or null if not found.
 */
async function findSnapshot(root: string, id: string): Promise<HistorySnapshot | null> {
  if (!isValidId(id)) throw new PathError("invalid snapshot id", 400);

  // Extract session UUID from the ID prefix.
  const slash = id.indexOf("/");
  const sessionId = id.slice(0, slash);

  const projectsAbs = join(root, PROJECTS_DIR);
  if (!(await dirExists(projectsAbs))) return null;

  const projectKeys = await safeDirents(projectsAbs);
  for (const pk of projectKeys) {
    const searchDir = pk.isDirectory() ? join(projectsAbs, pk.name) : projectsAbs;
    const fileName = pk.isDirectory() ? `${sessionId}.jsonl` : pk.name;
    if (!fileName.endsWith(".jsonl")) continue;

    const filePath = join(searchDir, fileName);
    try {
      await stat(filePath);
    } catch {
      continue;
    }

    // Collect only from this session's JSONL.
    const candidates: HistorySnapshot[] = [];
    await collectFromJsonl(root, filePath, candidates);
    const match = candidates.find((s) => s.id === id);
    if (match) return match;
  }

  return null;
}

/**
 * Read a physical history content file.
 *
 * The file lives at `<root>/file-history/<sessionId>/<backupFileName>`.
 * We go through safeResolveAsync to prevent any traversal.
 */
async function readHistoryFile(
  root: string,
  sessionId: string,
  backupFileName: string,
): Promise<string | null> {
  // Validate the components to prevent traversal before we even call safeResolve.
  if (!isSimpleName(sessionId) || !isSimpleName(backupFileName)) {
    return null;
  }
  const relPath = `${HISTORY_DIR}/${sessionId}/${backupFileName}`;
  let absPath: string;
  try {
    absPath = await safeResolveAsync(root, relPath);
  } catch {
    return null;
  }

  // Double-check the resolved path is inside the history dir (defense-in-depth).
  const historyAbs = join(root, HISTORY_DIR);
  if (!isInside(historyAbs, absPath)) return null;

  try {
    const buf = await readFile(absPath);
    if (buf.length > MAX_HISTORY_BYTES) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * A "simple name" is a path component with no slashes or traversal.
 * UUIDs and `<hash>@v<N>` names match this pattern.
 */
function isSimpleName(s: string): boolean {
  return typeof s === "string" && s.length > 0 && s.length < 200 && !/[/\\]/.test(s) && !s.includes("..");
}

/** Type-guard for a file-history-snapshot JSONL event. */
function isHistorySnapshotEvent(obj: unknown): obj is {
  type: string;
  snapshot: {
    timestamp: string;
    trackedFileBackups: Record<
      string,
      { backupFileName: string | null; version: number; backupTime?: string }
    >;
  };
} {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (o["type"] !== "file-history-snapshot") return false;
  const snap = o["snapshot"];
  if (typeof snap !== "object" || snap === null) return false;
  const s = snap as Record<string, unknown>;
  if (typeof s["timestamp"] !== "string") return false;
  if (typeof s["trackedFileBackups"] !== "object" || s["trackedFileBackups"] === null) return false;
  return true;
}

/** Return true if an absolute path exists and is a directory. */
async function dirExists(abs: string): Promise<boolean> {
  try {
    const st = await stat(abs);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** Read directory entries, returning [] on error. */
async function safeDirents(abs: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
}
