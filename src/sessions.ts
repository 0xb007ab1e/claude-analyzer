/**
 * Helpers for identifying and describing Claude Code session transcript files.
 *
 * Claude Code stores session transcripts as JSONL files at a path of the form:
 *   projects/<encoded-cwd>/<uuid>.jsonl
 *
 * The encoded CWD uses a simple encoding: the directory separator `/` is
 * replaced with `-`, so `/home/alice/project` becomes `-home-alice-project`.
 * Decoding is inherently ambiguous (a directory named `foo-bar` and one named
 * `foo/bar` produce the same encoding), but a best-effort human-readable label
 * is still useful for display purposes.
 */

/** Pattern for session transcript paths: projects/<encoded>/<uuid>.jsonl */
const SESSION_PATH_RE =
  /^projects\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Return true when `rel` looks like a Claude Code session transcript.
 *
 * A session transcript lives at `projects/<encoded-cwd>/<uuid>.jsonl` relative
 * to the `.claude` root. The UUID must be in standard hyphenated form.
 *
 * @param rel  Root-relative path using forward slashes (e.g. from {@link toRelative}).
 */
export function isSessionPath(rel: string): boolean {
  return SESSION_PATH_RE.test(rel);
}

/**
 * Extract the session UUID (filename without `.jsonl`) from a session path.
 *
 * Returns `null` when `rel` is not a session path.
 *
 * @param rel  Root-relative path (forward slashes).
 */
export function sessionUuid(rel: string): string | null {
  const m = SESSION_PATH_RE.exec(rel);
  return m ? (m[2] ?? null) : null;
}

/**
 * Decode the encoded project working directory from a session path.
 *
 * Claude Code encodes the CWD by replacing every `/` with `-`.  A leading `-`
 * therefore represents a leading `/` (absolute path), and subsequent `-`s
 * represent directory separators.  Because `-` is also a valid character in
 * directory names the decoding is **ambiguous**; we return a best-effort string
 * suitable for display only — never for filesystem operations.
 *
 * Examples:
 *   `-home-alice-project`   → `/home/alice/project`
 *   `-home-alice-my-app`    → `/home/alice/my/app`  (ambiguous with `my-app`)
 *   `projects`              → `projects`  (no leading dash → relative, returned as-is)
 *
 * Returns `null` when `rel` is not a session path.
 *
 * @param rel  Root-relative path (forward slashes).
 */
export function decodeProjectCwd(rel: string): string | null {
  const m = SESSION_PATH_RE.exec(rel);
  if (!m) return null;
  const encoded = m[1] ?? "";
  // A leading '-' signals an absolute path whose '/' was encoded as '-'.
  // Every '-' in the encoded string maps to '/' in the original.
  if (encoded.startsWith("-")) {
    return encoded.replace(/-/g, "/");
  }
  // No leading '-': treat as a relative path (unusual; return as-is).
  return encoded;
}

/** Metadata about a session file, exposed via the `/api/file` response. */
export interface SessionInfo {
  /** Whether this file is a Claude Code session transcript. */
  isSession: boolean;
  /** Best-effort decoded working directory of the session (may be ambiguous). */
  cwd: string | null;
  /** UUID of the session (filename without `.jsonl`). */
  uuid: string | null;
}

/**
 * Compute the {@link SessionInfo} for a root-relative path.
 *
 * Always returns an object — `isSession` is false when the path is not a
 * recognised session transcript, and `cwd`/`uuid` are `null` in that case.
 *
 * @param rel  Root-relative path (forward slashes).
 */
export function sessionInfo(rel: string): SessionInfo {
  if (!isSessionPath(rel)) {
    return { isSession: false, cwd: null, uuid: null };
  }
  return {
    isSession: true,
    cwd: decodeProjectCwd(rel),
    uuid: sessionUuid(rel),
  };
}
