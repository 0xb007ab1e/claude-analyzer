/**
 * Pure logic for the Settings Explorer: deep-merge of layered settings files,
 * object diffing, and unknown-key detection.
 *
 * All functions are stateless and free of I/O so they are trivially testable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of diffing two plain objects at their top-level keys. */
export interface ObjectDiff {
  /** Keys present in `next` but absent in `prev`. */
  added: string[];
  /** Keys present in `prev` but absent in `next`. */
  removed: string[];
  /** Keys present in both but whose serialized values differ. */
  changed: Array<{ key: string; oldValue: unknown; newValue: unknown }>;
}

// ---------------------------------------------------------------------------
// Known-keys catalog (heuristic — label as such in UI).
// Derived from Claude Code's documented and commonly-observed settings keys.
// ---------------------------------------------------------------------------

/**
 * Heuristic set of top-level settings keys that Claude Code is known to use.
 * Keys not in this set are flagged as "unknown/custom" — they may still be
 * valid (e.g. future additions), but warrant review.
 */
export const KNOWN_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  // Model & behaviour
  "model",
  "outputStyle",
  "autoUpdates",
  "enableAllProjectMcpServers",
  "forceLoginMethod",

  // Auth / API access
  "apiKeyHelper",

  // Display & UI
  "theme",
  "statusLine",
  "includeCoAuthoredBy",
  "cleanupPeriodDays",

  // Permissions
  "permissions",

  // Hooks
  "hooks",

  // Environment overrides
  "env",

  // MCP server configuration
  "mcpServers",

  // Telemetry / reporting
  "projects",

  // Misc configuration
  "preferredNotifChannel",
  "notifWebhook",
  "verboseSystemPrompt",
  "enableArtifacts",
  "disableNonEssentialTraffic",
  "ideInstallationInstructions",
]);

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

/**
 * Deep-merge two plain objects (records).  The `override` object wins on
 * scalar/array conflicts; nested objects are merged recursively.
 *
 * - `null` and non-objects are treated as scalars (not merged).
 * - Arrays are **replaced** whole (not element-merged) — matching Claude's own
 *   settings-merge semantics where e.g. `permissions` is replaced by the
 *   local override, not concatenated.
 *
 * @param base     The lower-priority object (e.g. `settings.json`).
 * @param override The higher-priority object (e.g. `settings.local.json`).
 * @returns A new plain object that is the deep-merge result.
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const bv = base[key];
    const ov = override[key];
    if (isPlainObject(ov) && isPlainObject(bv)) {
      // Both sides are plain objects — recurse.
      result[key] = deepMerge(
        bv as Record<string, unknown>,
        ov as Record<string, unknown>,
      );
    } else {
      // Scalar, array, null, or mismatched types — override wins.
      result[key] = ov;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// diffObjects
// ---------------------------------------------------------------------------

/**
 * Compute a shallow diff of two objects' top-level keys and their values.
 *
 * Comparison is by JSON serialisation so that object/array values are compared
 * structurally rather than by reference.
 *
 * @param prev The "old" object (e.g. settings.json backup).
 * @param next The "new" object (e.g. current settings.json).
 * @returns An {@link ObjectDiff} with added, removed, and changed key lists.
 */
export function diffObjects(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): ObjectDiff {
  const prevKeys = new Set(Object.keys(prev));
  const nextKeys = new Set(Object.keys(next));

  const added = [...nextKeys].filter((k) => !prevKeys.has(k));
  const removed = [...prevKeys].filter((k) => !nextKeys.has(k));
  const changed: ObjectDiff["changed"] = [];

  for (const key of prevKeys) {
    if (!nextKeys.has(key)) continue; // already in removed
    if (serialize(prev[key]) !== serialize(next[key])) {
      changed.push({ key, oldValue: prev[key], newValue: next[key] });
    }
  }

  return { added, removed, changed };
}

// ---------------------------------------------------------------------------
// flagUnknown
// ---------------------------------------------------------------------------

/**
 * Return the top-level keys of `obj` that are **not** in the `known` set.
 *
 * @param obj   The effective (merged) settings object.
 * @param known The curated set of known keys ({@link KNOWN_SETTINGS_KEYS}).
 * @returns     Array of unknown/custom key names (may be empty).
 */
export function flagUnknown(
  obj: Record<string, unknown>,
  known: ReadonlySet<string>,
): string[] {
  return Object.keys(obj).filter((k) => !known.has(k));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return true iff `v` is a non-null plain object (not an array). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deterministic JSON serialisation for value comparison. */
function serialize(v: unknown): string {
  return JSON.stringify(v) ?? "undefined";
}
