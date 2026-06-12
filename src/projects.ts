/**
 * Project-map helpers — enumerate the `projects/` directory under the Claude
 * root and return a structured view of each project's sessions.
 *
 * Claude Code encodes a working-directory path as a directory name under
 * `projects/` by replacing every `/` separator with `-`. For example,
 * `/home/alice/myrepo` becomes `-home-alice-myrepo`. The leading `-` indicates
 * the path was absolute. We reverse this heuristically; single-dash segments
 * that happen to contain a literal dash are ambiguous and are labelled as such.
 *
 * Security note: we stat the decoded cwd as a plain existence check only —
 * we do NOT read its contents and we deliberately allow paths outside the
 * configured root (a cwd can be anything on the machine). The stat result is
 * informational only and is surfaced as `exists: boolean`.
 */

import { readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { safeResolveAsync, toRelative } from "./paths.ts";
import { extractSessionCwd } from "./sessions.ts";

/** Bytes of the newest session file read to recover the real cwd. */
const CWD_PROBE_BYTES = 65536;

/**
 * Read the real working directory recorded in a project's newest session file.
 * Only the first {@link CWD_PROBE_BYTES} are read (the cwd appears early), so
 * this stays cheap even for multi-MB transcripts.
 *
 * @param fileAbs  Absolute path to the newest `.jsonl` session file.
 * @returns        The recorded cwd, or `null` if unreadable / not present.
 */
async function readSessionCwd(fileAbs: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(fileAbs, "r");
    const buf = Buffer.alloc(CWD_PROBE_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return extractSessionCwd(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** One session file inside a project directory. */
export interface SessionEntry {
  /** Filename without the `.jsonl` extension — the session UUID. */
  uuid: string;
  /** Root-relative path to the `.jsonl` file. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** Modified time (epoch ms). */
  mtime: number;
}

/** One project as returned by {@link listProjects}. */
export interface ProjectEntry {
  /** The raw encoded directory name (as stored on disk). */
  encoded: string;
  /** Working-directory path: exact when read from session content, else a best-effort decode of the dir name. */
  cwd: string;
  /** True when `cwd` came from session content (reliable); false when heuristically decoded. */
  cwdExact: boolean;
  /** True when `cwd` exists on disk at the time of the call. */
  exists: boolean;
  /** Total number of session (`.jsonl`) files present in the directory. */
  sessionCount: number;
  /** Up to {@link SESSION_CAP} sessions, sorted by mtime descending. */
  sessions: SessionEntry[];
  /** True when the project has more sessions than {@link SESSION_CAP}. */
  truncated: boolean;
  /** Max mtime of all sessions (0 if no sessions). */
  lastUsed: number;
}

/**
 * Maximum number of sessions returned per project. Additional sessions exist
 * (reflected in `sessionCount`) but are not listed individually.
 */
export const SESSION_CAP = 50;

/**
 * Decode a Claude Code encoded project directory name to its best-effort
 * real working-directory path.
 *
 * Claude Code encodes an absolute path like `/home/alice/my-repo` as
 * `-home-alice-my-repo` by replacing every `/` with `-`. This is a lossy
 * encoding: a directory segment that contains a literal `-` is
 * indistinguishable from a path separator. We reverse the leading `-` to `/`
 * (making the path absolute) and convert remaining `-` to `/`, which is
 * correct for paths whose segments contain no dashes. For paths where a
 * segment genuinely contains a dash the result is a best-effort heuristic.
 *
 * @param encoded  The raw directory name under `projects/`, e.g. `-home-alice-myrepo`.
 * @returns        The decoded path string, e.g. `/home/alice/myrepo`.
 */
export function decodeProjectCwd(encoded: string): string {
  if (encoded === "") return "/";

  // A leading `-` signals an absolute path: turn the leading `-` into `/` then
  // replace all remaining `-` with `/`.
  if (encoded.startsWith("-")) {
    // Drop the leading `-`; the whole string then represents `<sep>segments<sep>...`
    return "/" + encoded.slice(1).replace(/-/g, "/");
  }

  // No leading dash: relative path or unusual encoding — convert `-` → `/` as-is.
  return encoded.replace(/-/g, "/");
}

/**
 * Check whether a path exists on disk.
 *
 * This is a plain `stat` call. The path may be anywhere on the machine
 * (it is a decoded cwd, not a path inside the app root). We only need the
 * boolean result; we never read the directory contents.
 *
 * @param cwdPath  Absolute path to check.
 * @returns        `true` if the path exists (directory or file), `false` otherwise.
 */
async function cwdExists(cwdPath: string): Promise<boolean> {
  try {
    await stat(cwdPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all projects under `<root>/projects/`, decoding each directory name
 * and enumerating its session files.
 *
 * Results are sorted by `lastUsed` descending (most-recently-active first).
 * Projects with no sessions sort last; ties are broken by encoded name.
 *
 * @param root  The realpath'd Claude root directory (from {@link Config}).
 * @returns     Array of {@link ProjectEntry} sorted by lastUsed desc.
 */
export async function listProjects(root: string): Promise<ProjectEntry[]> {
  // Confine to root — projects/ must live inside root.
  const projectsAbs = await safeResolveAsync(root, "projects");

  // Read the projects/ directory; if it doesn't exist return an empty list.
  let projectDirs: string[];
  try {
    const dirents = await readdir(projectsAbs, { withFileTypes: true });
    projectDirs = dirents
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const results: ProjectEntry[] = [];

  for (const encoded of projectDirs) {
    const projectAbs = join(projectsAbs, encoded);
    const projectRel = toRelative(root, projectAbs);

    // Enumerate .jsonl session files inside this project directory.
    let sessionFiles: Array<{ name: string; size: number; mtime: number }> = [];
    try {
      const entries = await readdir(projectAbs, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
        try {
          const st = await stat(join(projectAbs, e.name));
          sessionFiles.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
        } catch {
          // Vanished file — skip.
        }
      }
    } catch {
      // Unreadable directory — include the project but with no sessions.
    }

    // Sort sessions by mtime descending (newest first) before capping.
    sessionFiles.sort((a, b) => b.mtime - a.mtime);

    const sessionCount = sessionFiles.length;
    const truncated = sessionCount > SESSION_CAP;
    const capped = truncated ? sessionFiles.slice(0, SESSION_CAP) : sessionFiles;

    const sessions: SessionEntry[] = capped.map((f) => ({
      uuid: f.name.slice(0, -".jsonl".length),
      path: `${projectRel}/${f.name}`,
      size: f.size,
      mtime: f.mtime,
    }));

    const lastUsed = sessionFiles.length > 0 ? (sessionFiles[0]?.mtime ?? 0) : 0;

    // Prefer the real cwd recorded in the newest session; fall back to the
    // lossy directory-name decode only when no session content is available.
    let cwd = decodeProjectCwd(encoded);
    let cwdExact = false;
    const newest = sessionFiles[0];
    if (newest) {
      const realCwd = await readSessionCwd(join(projectAbs, newest.name));
      if (realCwd) {
        cwd = realCwd;
        cwdExact = true;
      }
    }
    const exists = await cwdExists(cwd);

    results.push({
      encoded,
      cwd,
      cwdExact,
      exists,
      sessionCount,
      sessions,
      truncated,
      lastUsed,
    });
  }

  // Sort by lastUsed descending; break ties by encoded name for stability.
  results.sort((a, b) => {
    if (b.lastUsed !== a.lastUsed) return b.lastUsed - a.lastUsed;
    return a.encoded.localeCompare(b.encoded);
  });

  return results;
}
