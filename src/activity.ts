/**
 * Activity timeline — filesystem mtime aggregation.
 *
 * Pure logic module: walks the root tree to collect file modification times,
 * then buckets them into per-day counts and an hour-of-day histogram. All
 * functions accept an explicit `nowMs` parameter so they are deterministic and
 * unit-testable without mocking the clock.
 *
 * The tree walk is confined to the configured root via the same path helpers
 * used everywhere else in the app (CWE-22 prevention), and is capped at a
 * maximum number of files to avoid exhausting memory on very large trees.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { safeResolveAsync } from "./paths.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum files to scan before setting the {@link ActivityResult.truncated} flag. */
const MAX_FILES = 20_000;

/** Directories to skip during the tree walk (always excluded). */
const SKIP_DIRS = new Set([".git", ".analyzer-backups", "node_modules"]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One day's change count. */
export interface DayBucket {
  /** ISO date string — `YYYY-MM-DD` in the local-ish UTC offset used throughout. */
  date: string;
  /** Number of files whose mtime falls on this day. */
  count: number;
}

/** Result returned by {@link buildActivityResult}. */
export interface ActivityResult {
  /** Per-day buckets, sorted ascending from `range.fromMs` to `range.toMs`. */
  days: DayBucket[];
  /**
   * 24-element array: `byHour[h]` is the number of files modified during hour
   * `h` (0 = midnight, 23 = 11 PM) across the whole requested window.
   */
  byHour: number[];
  /** The day with the highest count in the window (or null if no data). */
  busiestDay: { date: string; count: number } | null;
  /** The hour (0-23) with the highest count (or null if no data). */
  busiestHour: { hour: number; count: number } | null;
  /** Total number of mtime data points counted in the window. */
  total: number;
  /** The inclusive window boundaries (epoch ms). */
  range: { fromMs: number; toMs: number };
  /** True if the walk hit MAX_FILES and stopped early. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Pure bucketing helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Build a sorted array of per-day buckets for every day in `[fromMs, toMs]`,
 * counting how many of the given `mtimesMs` fall in each day.
 *
 * Days without any files still appear in the result with `count: 0`, so the
 * UI can render an unbroken calendar grid.
 *
 * @param mtimesMs - Epoch-ms modification times to bucket (may be empty).
 * @param fromMs   - Start of the window (epoch ms, inclusive).
 * @param toMs     - End of the window (epoch ms, inclusive), must be ≥ fromMs.
 * @param nowMs    - Current time (epoch ms); used only to verify parameters —
 *                   pass `Date.now()` in production, or a fixed value in tests.
 * @returns Sorted array of {@link DayBucket}, one per calendar day in the window.
 */
export function bucketByDay(
  mtimesMs: number[],
  fromMs: number,
  toMs: number,
): DayBucket[] {
  // Build the day-label → count index.
  const counts = new Map<string, number>();

  // Count only mtimes within the window.
  for (const t of mtimesMs) {
    if (t < fromMs || t > toMs) continue;
    const label = msToDateLabel(t);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  // Enumerate every calendar day in the window (even zeros).
  const result: DayBucket[] = [];
  const fromDay = floorToDay(fromMs);
  const toDay = floorToDay(toMs);
  for (let d = fromDay; d <= toDay; d += 86_400_000) {
    const label = msToDateLabel(d);
    result.push({ date: label, count: counts.get(label) ?? 0 });
  }

  return result;
}

/**
 * Build a 24-element hour-of-day histogram from `mtimesMs`.
 *
 * All times that fall within `[fromMs, toMs]` are counted; those outside the
 * window are ignored.
 *
 * @param mtimesMs - Epoch-ms modification times.
 * @param fromMs   - Window start (epoch ms, inclusive).
 * @param toMs     - Window end (epoch ms, inclusive).
 * @returns Array of 24 non-negative integers, index = UTC hour.
 */
export function bucketByHour(
  mtimesMs: number[],
  fromMs: number,
  toMs: number,
): number[] {
  const hist = new Array<number>(24).fill(0);
  for (const t of mtimesMs) {
    if (t < fromMs || t > toMs) continue;
    const h = new Date(t).getUTCHours();
    hist[h]++;
  }
  return hist;
}

/**
 * Assemble the full {@link ActivityResult} from raw mtime data.
 *
 * This is the single entry point for callers that already have the mtime
 * array (useful for testing without touching the filesystem).
 *
 * @param mtimesMs  - All collected mtime values (epoch ms).
 * @param days      - Window size in calendar days (1–365).
 * @param nowMs     - "Now" timestamp (epoch ms) — pass `Date.now()` in prod.
 * @param truncated - Whether the tree walk was cut short.
 */
export function summarize(
  mtimesMs: number[],
  days: number,
  nowMs: number,
  truncated: boolean,
): ActivityResult {
  // Clamp days to a safe range.
  const d = Math.max(1, Math.min(365, days));

  // Window: [startOfDay(now - (d-1) days) .. end of today].
  const toMs = endOfDay(nowMs);
  const fromMs = floorToDay(nowMs) - (d - 1) * 86_400_000;

  const dayBuckets = bucketByDay(mtimesMs, fromMs, toMs);
  const byHour = bucketByHour(mtimesMs, fromMs, toMs);

  // Busiest day.
  let busiestDay: ActivityResult["busiestDay"] = null;
  for (const b of dayBuckets) {
    if (b.count > 0 && (!busiestDay || b.count > busiestDay.count)) {
      busiestDay = { date: b.date, count: b.count };
    }
  }

  // Busiest hour.
  let busiestHour: ActivityResult["busiestHour"] = null;
  for (let h = 0; h < 24; h++) {
    const c = byHour[h] ?? 0;
    if (c > 0 && (!busiestHour || c > busiestHour.count)) {
      busiestHour = { hour: h, count: c };
    }
  }

  const total = dayBuckets.reduce((s, b) => s + b.count, 0);

  return {
    days: dayBuckets,
    byHour,
    busiestDay,
    busiestHour,
    total,
    range: { fromMs, toMs },
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

/**
 * Recursively collect the mtime (epoch ms) of every regular file under `root`,
 * skipping hidden/system directories and capping at {@link MAX_FILES}.
 *
 * @param root - Absolute, already-realpath'd root directory.
 * @returns `{ mtimesMs, truncated }` where `truncated` is true if the cap was hit.
 */
export async function collectMtimes(
  root: string,
): Promise<{ mtimesMs: number[]; truncated: boolean }> {
  const mtimesMs: number[] = [];
  let truncated = false;

  // Iterative BFS using a queue of absolute directory paths, all pre-verified
  // to be inside root before they enter the queue.
  const queue: string[] = [root];

  outer: while (queue.length > 0) {
    const dir = queue.shift()!;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // permission error or race — skip
    }

    for (const entry of entries) {
      const abs = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip excluded dirs regardless of depth.
        if (SKIP_DIRS.has(entry.name)) continue;
        // Confinement: verify the resolved path stays inside root.
        let safe: string;
        try {
          safe = await safeResolveAsync(root, abs.slice(root.length + 1));
        } catch {
          continue; // escapes root or unresolvable — skip
        }
        queue.push(safe);
      } else if (entry.isFile()) {
        if (mtimesMs.length >= MAX_FILES) {
          truncated = true;
          break outer;
        }
        try {
          const st = await stat(abs);
          mtimesMs.push(st.mtimeMs);
        } catch {
          // Race: file vanished between readdir and stat — skip.
        }
      }
      // Symlinks, sockets, etc. are intentionally ignored.
    }
  }

  return { mtimesMs, truncated };
}

// ---------------------------------------------------------------------------
// Date helpers (UTC-based for determinism)
// ---------------------------------------------------------------------------

/**
 * Return the `YYYY-MM-DD` label for an epoch-ms timestamp (UTC).
 *
 * Using UTC throughout avoids timezone surprises in both the server logic and
 * the unit tests. The UI may choose to display in local time for aesthetics.
 */
export function msToDateLabel(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Truncate `ms` to the start of its UTC day (00:00:00.000 UTC).
 */
export function floorToDay(ms: number): number {
  return ms - (ms % 86_400_000);
}

/**
 * Return the last millisecond of the UTC day containing `ms` (23:59:59.999 UTC).
 */
export function endOfDay(ms: number): number {
  return floorToDay(ms) + 86_400_000 - 1;
}
