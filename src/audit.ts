/**
 * Security audit — pure logic helpers.
 *
 * This module contains the CPU-only, side-effect-free functions used by the
 * `/api/audit` endpoint. Keeping them separate makes them trivially unit-
 * testable without any filesystem setup.
 *
 * The mask token written by redact.ts when it replaces a secret-shaped value.
 * We count its occurrences in the redacted text to get a hit count without
 * ever holding the raw secret value.
 */

/** The literal mask written by {@link redactText} when it redacts a value. */
export const REDACT_MASK = "«redacted»";

/**
 * Count how many times the mask token appears in a redacted text blob.
 *
 * Each occurrence corresponds to exactly one secret-shaped value that was
 * replaced, so the count is a safe proxy for "how many secrets did we find"
 * without keeping any raw credential in memory or in the response.
 *
 * @param redactedText  The output of `redactText(...)`.
 * @param mask          The mask token to count (defaults to `«redacted»`).
 * @returns             Non-negative integer hit count.
 */
export function countMaskHits(
  redactedText: string,
  mask: string = REDACT_MASK,
): number {
  if (!mask) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = redactedText.indexOf(mask, pos)) !== -1) {
    count++;
    pos += mask.length;
  }
  return count;
}

/**
 * Extract a single, safe, masked line snippet from a redacted text blob.
 *
 * Finds the first line that contains the mask token and returns it, truncated
 * to 200 characters. The returned snippet is guaranteed to contain only the
 * mask placeholder — no raw secret value can appear because the input is
 * already redacted.
 *
 * Returns `""` when no masked line is found (e.g. the file was flagged only
 * via a sensitive path, not via inline content).
 *
 * @param redactedText  The output of `redactText(...)`.
 * @param mask          The mask token to search for.
 * @returns             A single masked snippet line, or `""`.
 */
export function firstMaskedSnippet(
  redactedText: string,
  mask: string = REDACT_MASK,
): string {
  const lines = redactedText.split("\n");
  for (const line of lines) {
    if (line.includes(mask)) {
      return line.trim().slice(0, 200);
    }
  }
  return "";
}

/** Unix file mode bits checked for group/world read or execute access. */
const GROUP_WORLD_MASK = 0o077;

/**
 * Determine whether a file's mode has any group or world permission bits set.
 *
 * A mode of `0o600` is fine; `0o644` or `0o664` would return `true` because
 * the group-read bit is set. Used to flag sensitive files that are readable by
 * more than just their owner.
 *
 * @param mode  Integer mode from `fs.Stats.mode` (e.g. `0o100644`).
 * @returns     `true` when any group or world permission bit is set.
 */
export function isGroupOrWorldReadable(mode: number): boolean {
  return (mode & GROUP_WORLD_MASK) !== 0;
}

/**
 * Format a numeric file mode as a human-readable octal string.
 *
 * Strips the file-type high bits and returns the traditional 4-digit octal
 * permission string (e.g. `"0644"`).
 *
 * @param mode  Integer mode from `fs.Stats.mode`.
 * @returns     Zero-padded 4-character octal string, e.g. `"0644"`.
 */
export function modeToOctal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/**
 * A top-level-directory bucket and the total bytes of files inside it.
 *
 * The `dir` field is the top-level component of a root-relative path (e.g.
 * `"projects"` for `"projects/foo/bar.json"`). Files at the root itself are
 * grouped under `""`.
 */
export interface DirSize {
  /** Top-level directory name, or `""` for root-level files. */
  dir: string;
  /** Total byte count of all files under this top-level directory. */
  bytes: number;
}

/**
 * Aggregate per-top-level-directory byte totals from a flat map of
 * root-relative paths to byte sizes.
 *
 * @param entries  Map from root-relative path (`"foo/bar/baz.json"`) to size.
 * @returns        Array of `{dir, bytes}` sorted by bytes descending.
 */
export function summarizeSizes(entries: Map<string, number>): DirSize[] {
  const byDir = new Map<string, number>();
  for (const [relPath, size] of entries) {
    const topDir = relPath.includes("/") ? relPath.split("/")[0]! : "";
    byDir.set(topDir, (byDir.get(topDir) ?? 0) + size);
  }
  return [...byDir.entries()]
    .map(([dir, bytes]) => ({ dir, bytes }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** Classifiable path patterns for stale/reclaimable areas. */
const STALE_PATTERNS: ReadonlyArray<{ match: (rel: string) => boolean; suggestion: string }> = [
  {
    match: (r) => r.startsWith(".analyzer-backups/") || r === ".analyzer-backups",
    suggestion: "Pre-write backups — safe to delete once you have verified the edited files.",
  },
  {
    match: (r) => r.startsWith("paste-cache/") || r === "paste-cache",
    suggestion: "Paste cache — likely reclaimable; re-open or re-paste to regenerate.",
  },
  {
    match: (r) => r.startsWith("shell-snapshots/") || r === "shell-snapshots",
    suggestion: "Shell snapshots — reclaimable once you no longer need them for review.",
  },
  {
    match: (r) =>
      r.startsWith("backups/") ||
      r === "backups" ||
      /\.(bak|backup)$/i.test(r),
    suggestion: "Backup file — reclaimable if the original is current and verified.",
  },
  {
    match: (r) => /\.log$/i.test(r) || r.startsWith("logs/"),
    suggestion: "Log file — reclaimable; rotate or archive if still needed.",
  },
];

/** Age threshold beyond which a file is considered stale (days). */
const STALE_AGE_DAYS = 90;

/**
 * Classify whether a file is likely reclaimable and suggest an action.
 *
 * A file is considered stale when it matches a known reclaimable pattern
 * *or* when it is older than {@link STALE_AGE_DAYS} days.  The function never
 * recommends deletion directly — it always returns an advisory string.
 *
 * @param relPath  Root-relative path of the file.
 * @param ageDays  Age of the file in days (can be fractional).
 * @returns        Suggestion string if the file is stale, or `null` if it is not.
 */
export function classifyStale(relPath: string, ageDays: number): string | null {
  for (const p of STALE_PATTERNS) {
    if (p.match(relPath)) return p.suggestion;
  }
  if (ageDays >= STALE_AGE_DAYS) {
    return `File not modified in ${Math.floor(ageDays)} days — review whether it is still needed.`;
  }
  return null;
}
