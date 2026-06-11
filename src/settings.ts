/**
 * Settings-explorer I/O layer.
 *
 * Reads the layered settings files that Claude Code uses, deep-merges them
 * into one effective object, gathers any .bak siblings of settings.json, and
 * diffs the current settings.json against the most-recent backup.
 *
 * Pure merge/diff/flag logic lives in {@link ./settingsmerge.ts}; this module
 * handles only filesystem access and ties the pieces together.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { safeResolveAsync } from "./paths.ts";
import { isSensitiveKey, redactText } from "./redact.ts";
import { deepMerge, diffObjects, flagUnknown, KNOWN_SETTINGS_KEYS, type ObjectDiff } from "./settingsmerge.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One settings layer (a parsed file or a parse error). */
export interface SettingsLayer {
  /** Root-relative file path (forward slashes). */
  file: string;
  /** Whether this file is a backup (e.g. settings.json.bak). */
  isBak: boolean;
  /** Parsed contents when the file was valid JSON; null on error or missing. */
  parsed: Record<string, unknown> | null;
  /** Parse error message if the file existed but wasn't valid JSON. */
  parseError?: string;
  /** True if the file did not exist (silently absent is fine). */
  missing?: boolean;
}

/** A single diffed key entry, with values optionally redacted. */
export interface DiffEntry {
  key: string;
  oldValue: unknown;
  newValue: unknown;
}

/** The full response shape for GET /api/settings. */
export interface SettingsResponse {
  /** All layers that were read (main + local + backups), in read order. */
  layers: SettingsLayer[];
  /**
   * The effective merged object (settings.json deep-merged with
   * settings.local.json overrides).  Secret values are masked unless
   * reveal=true was requested.
   */
  effective: Record<string, unknown>;
  /** Top-level effective keys not in the curated known-keys list. */
  unknownKeys: string[];
  /**
   * Diff between the current settings.json and the most-recently-modified
   * .bak sibling, or null if no backup exists (or if the base layer is
   * missing / unparseable).
   */
  bakDiff: {
    bakFile: string;
    added: string[];
    removed: string[];
    changed: DiffEntry[];
  } | null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Read all settings layers under `root`, merge them, diff against backups,
 * and return the structured response.
 *
 * @param root    The configured root directory (absolute, already realpath'd).
 * @param reveal  When false (default), mask secret values in the effective
 *                object and diff entries via {@link isSensitiveKey}. When true,
 *                return raw values (caller must have already confirmed intent).
 */
export async function readSettings(
  root: string,
  reveal: boolean,
): Promise<SettingsResponse> {
  // --- 1. Read the primary layers -------------------------------------------
  const baseLayer = await readLayer(root, "settings.json", false);
  const localLayer = await readLayer(root, "settings.local.json", false);

  // --- 2. Gather backup siblings of settings.json ---------------------------
  const bakLayers = await readBakLayers(root);

  // --- 3. Build effective merged object -------------------------------------
  const baseParsed = baseLayer.parsed ?? {};
  const localParsed = localLayer.parsed ?? {};
  const rawEffective = deepMerge(baseParsed, localParsed);

  const effective = reveal ? rawEffective : redactObjectValues(rawEffective);

  // --- 4. Unknown-key detection ---------------------------------------------
  const unknownKeys = flagUnknown(rawEffective, KNOWN_SETTINGS_KEYS);

  // --- 5. Diff current settings.json vs most-recent backup ------------------
  let bakDiff: SettingsResponse["bakDiff"] = null;
  if (baseParsed && Object.keys(baseParsed).length > 0 && bakLayers.length > 0) {
    // Pick the most-recently-modified backup.
    const mostRecent = bakLayers.reduce((a, b) => {
      const aTime = a._mtime ?? 0;
      const bTime = b._mtime ?? 0;
      return bTime > aTime ? b : a;
    });
    if (mostRecent.parsed !== null) {
      const rawDiff = diffObjects(mostRecent.parsed, baseParsed);
      bakDiff = {
        bakFile: mostRecent.file,
        added: rawDiff.added,
        removed: rawDiff.removed,
        changed: reveal
          ? rawDiff.changed.map(({ key, oldValue, newValue }) => ({ key, oldValue, newValue }))
          : rawDiff.changed.map(({ key, oldValue, newValue }) => ({
              key,
              oldValue: isSensitiveKey(key) ? "«redacted»" : oldValue,
              newValue: isSensitiveKey(key) ? "«redacted»" : newValue,
            })),
      };
    }
  }

  // Strip the internal _mtime field from bak layers before returning.
  const layers: SettingsLayer[] = [
    stripMtime(baseLayer),
    stripMtime(localLayer),
    ...bakLayers.map(stripMtime),
  ].filter((l) => !l.missing);

  // Apply redaction to layer parsed objects too (unless revealing).
  if (!reveal) {
    for (const layer of layers) {
      if (layer.parsed !== null) {
        layer.parsed = redactObjectValues(layer.parsed);
      }
    }
  }

  return { layers, effective, unknownKeys, bakDiff };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extended internal layer with modification time for backup ordering. */
interface InternalLayer extends SettingsLayer {
  _mtime?: number;
}

/**
 * Read a single settings file and return a layer descriptor.
 *
 * Missing files are represented with `missing: true`; parse errors with
 * `parseError`. Never throws — errors are captured into the return value.
 */
async function readLayer(
  root: string,
  relName: string,
  isBak: boolean,
): Promise<InternalLayer> {
  let absPath: string;
  try {
    absPath = await safeResolveAsync(root, relName);
  } catch {
    return { file: relName, isBak, parsed: null, missing: true };
  }

  let raw: string;
  let mtime: number | undefined;
  try {
    const st = await stat(absPath);
    mtime = st.mtimeMs;
    raw = await readFile(absPath, "utf8");
  } catch {
    return { file: relName, isBak, parsed: null, missing: true, _mtime: 0 };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { file: relName, isBak, parsed: null, parseError: "root value is not an object", _mtime: mtime };
    }
    return { file: relName, isBak, parsed, _mtime: mtime };
  } catch (e) {
    return { file: relName, isBak, parsed: null, parseError: (e as Error).message, _mtime: mtime };
  }
}

/**
 * Discover and read all `settings.json.*` sibling backup files under `root`.
 *
 * Matches any file whose name starts with `settings.json.` — this covers
 * `settings.json.bak`, `settings.json.cs-bak`, `settings.json.usage-guard-bak`,
 * and timestamped backups created by the write-guard in files.ts.
 */
async function readBakLayers(root: string): Promise<InternalLayer[]> {
  let names: string[];
  try {
    const absRoot = await safeResolveAsync(root, "");
    const dirents = await readdir(absRoot);
    names = dirents.filter((n) => n.startsWith("settings.json."));
  } catch {
    return [];
  }

  const results: InternalLayer[] = [];
  for (const name of names) {
    const layer = await readLayer(root, name, true);
    results.push(layer);
  }
  return results;
}

/**
 * Redact secret-looking string values from a plain object's top-level keys.
 *
 * Walks the object shallowly at the top level: if a key is sensitive
 * (per {@link isSensitiveKey}), its value is replaced with `"«redacted»"`.
 * Nested objects are left structurally intact but their string values that
 * match sensitive keys are also masked (one level of recursion is sufficient
 * for the common settings shapes).
 *
 * For a deeper/broader redaction of free-form text content, callers should
 * use {@link redactText} from redact.ts instead; this function is optimised
 * for the known key/value structure of settings objects.
 */
function redactObjectValues(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSensitiveKey(k)) {
      out[k] = typeof v === "string" ? "«redacted»" : "«redacted»";
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      out[k] = redactObjectValues(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Remove the internal _mtime field from an InternalLayer. */
function stripMtime({ _mtime: _ignored, ...rest }: InternalLayer): SettingsLayer {
  return rest;
}
