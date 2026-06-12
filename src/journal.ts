/**
 * Persistent event journal — the observability tracker's storage layer.
 *
 * Turns the otherwise-ephemeral activity stream (filesystem changes, secret
 * reveals, writes, restores, errors) into an append-only JSONL history that
 * survives restarts, so the UI can show *how the `.claude` directory is used
 * over time* rather than only what changed since boot.
 *
 * Design notes:
 *  - **Stored outside the watched root.** The journal lives in the user's state
 *    directory (XDG `state`), never inside `.claude`. Writing inside the root
 *    would make the directory watcher observe the journal's own writes — an
 *    infinite feedback loop. {@link resolveJournalDir} additionally falls back
 *    to a temp location if the computed path would land inside the root.
 *  - **No secrets, ever.** Events record *metadata* only — a path, an event
 *    kind, a byte count — never file contents or revealed values (master §5).
 *  - **Bounded.** The active file is rotated to a single `.1` backup once it
 *    exceeds {@link JournalOptions.maxBytes}, so disk use is capped.
 *  - **Serialised, non-blocking appends.** Writes are chained through an
 *    internal promise queue so concurrent `record()` calls can't interleave a
 *    line; callers may fire-and-forget.
 *
 * The aggregation helper {@link aggregateEvents} is pure and takes an explicit
 * `nowMs`, so the dashboard maths is deterministic and unit-testable. It reuses
 * the day/hour bucketing from {@link "./activity.ts"}.
 */

import { appendFile, readFile, rename, mkdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { bucketByDay, bucketByHour, type DayBucket } from "./activity.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single recorded event. `ts` is epoch ms; `kind` groups events; the rest is free-form metadata. */
export interface JournalEvent {
  /** Event time (epoch ms). */
  ts: number;
  /** Event kind, e.g. "fschange" | "reveal" | "write" | "restore" | "audit" | "error". */
  kind: string;
  /** Root-relative path the event concerns, when applicable (never a secret value). */
  path?: string;
  /** Filesystem operation for fschange events: "rename" (create/delete/move) | "change". */
  op?: string;
  /** Byte count for writes. */
  bytes?: number;
  /** Short, non-sensitive message for audit/error events. */
  msg?: string;
}

/** Tunables for {@link Journal}. */
export interface JournalOptions {
  /** Rotate the active file once it grows past this many bytes (default 5 MiB). */
  maxBytes?: number;
}

/** Aggregated view of a window of events, for the dashboard. */
export interface JournalAggregate {
  /** Per-day event counts across the window (zero-filled). */
  days: DayBucket[];
  /** 24-element hour-of-day histogram (UTC). */
  byHour: number[];
  /** Event counts grouped by `kind`. */
  byKind: Record<string, number>;
  /** Top paths by event count (descending), capped. */
  topPaths: { path: string; count: number }[];
  /** Total events counted in the window. */
  total: number;
  /** Inclusive window boundaries (epoch ms). */
  range: { fromMs: number; toMs: number };
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/**
 * Default state directory for the app's own data, following the XDG Base
 * Directory spec: `$XDG_STATE_HOME/claude-analyzer`, else
 * `~/.local/state/claude-analyzer`.
 */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME?.trim()
    ? env.XDG_STATE_HOME
    : join(env.HOME ?? homedir(), ".local", "state");
  return join(base, "claude-analyzer");
}

/**
 * Resolve the directory the journal should live in, guaranteeing it is **not**
 * inside `root` (which would create a watcher feedback loop). Falls back to a
 * stable per-machine temp location if the default would be inside the root.
 *
 * @param root  The confined `.claude` root (absolute, realpath'd).
 * @param env   Environment (for XDG/HOME).
 */
export function resolveJournalDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = resolve(defaultStateDir(env));
  const r = resolve(root);
  if (dir === r || dir.startsWith(r + sep)) {
    // Pathological config (root encloses the state dir) — use a temp location.
    return join(tmpdir(), "claude-analyzer-state");
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB active file
/** Hard cap on a single serialised event line, to bound a pathological record. */
const MAX_LINE_BYTES = 4096;

/**
 * Append-only event store backed by a JSONL file with single-backup rotation.
 */
export class Journal {
  readonly dir: string;
  readonly file: string;
  readonly backup: string;
  readonly #maxBytes: number;
  /** Serialises appends so lines never interleave. */
  #tail: Promise<void> = Promise.resolve();
  /** Running size of the active file (bytes); `null` until first stat. */
  #size: number | null = null;
  #ready = false;

  /**
   * @param dir   Directory to store the journal in (created on first write).
   * @param opts  Optional tunables.
   */
  constructor(dir: string, opts: JournalOptions = {}) {
    this.dir = dir;
    this.file = join(dir, "events.jsonl");
    this.backup = join(dir, "events.jsonl.1");
    this.#maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /**
   * Append one event. Returns a promise that resolves when the line is on disk;
   * callers may ignore it (fire-and-forget). Never throws to the caller — I/O
   * failures are swallowed (observability must not break the request path).
   *
   * The event is shallow-copied and any non-allow-listed fields are dropped, so
   * a caller can't accidentally journal a secret-bearing object.
   */
  record(event: JournalEvent): Promise<void> {
    const safe = sanitiseEvent(event);
    let line = JSON.stringify(safe);
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      // Drop the optional metadata and keep just ts/kind to stay bounded.
      line = JSON.stringify({ ts: safe.ts, kind: safe.kind });
    }
    const payload = line + "\n";
    this.#tail = this.#tail
      .then(() => this.#append(payload))
      .catch(() => {
        /* swallow — never break the request path on a journal failure */
      });
    return this.#tail;
  }

  /** Internal: ensure dir, rotate if needed, append, track size. */
  async #append(payload: string): Promise<void> {
    if (!this.#ready) {
      await mkdir(this.dir, { recursive: true });
      try {
        this.#size = (await stat(this.file)).size;
      } catch {
        this.#size = 0;
      }
      this.#ready = true;
    }
    const bytes = Buffer.byteLength(payload);
    if (this.#size !== null && this.#size + bytes > this.#maxBytes && this.#size > 0) {
      try {
        await rename(this.file, this.backup); // replaces any existing .1
      } catch {
        /* ignore — keep appending to the current file if rotate fails */
      }
      this.#size = 0;
    }
    await appendFile(this.file, payload, "utf8");
    this.#size = (this.#size ?? 0) + bytes;
  }

  /**
   * Read recent events, newest first, across the backup + active file.
   *
   * @param opts.sinceMs  Only include events at/after this time (epoch ms).
   * @param opts.untilMs  Only include events at/before this time (epoch ms).
   * @param opts.kinds    Restrict to these kinds.
   * @param opts.path     Restrict to events whose `path` exactly equals this.
   * @param opts.limit    Maximum events to return (default 500, hard cap 5000).
   */
  async query(
    opts: { sinceMs?: number; untilMs?: number; kinds?: string[]; path?: string; limit?: number } = {},
  ): Promise<JournalEvent[]> {
    const limit = Math.max(1, Math.min(5000, opts.limit ?? 500));
    const kinds = opts.kinds ? new Set(opts.kinds) : null;
    const events: JournalEvent[] = [];
    // Oldest file first so chronological order is preserved before we reverse.
    for (const f of [this.backup, this.file]) {
      let text: string;
      try {
        text = await readFile(f, "utf8");
      } catch {
        continue; // file may not exist yet
      }
      for (const raw of text.split("\n")) {
        if (!raw) continue;
        let ev: JournalEvent;
        try {
          ev = JSON.parse(raw) as JournalEvent;
        } catch {
          continue; // skip a torn/partial trailing line
        }
        if (typeof ev.ts !== "number" || typeof ev.kind !== "string") continue;
        if (opts.sinceMs !== undefined && ev.ts < opts.sinceMs) continue;
        if (opts.untilMs !== undefined && ev.ts > opts.untilMs) continue;
        if (kinds && !kinds.has(ev.kind)) continue;
        if (opts.path !== undefined && ev.path !== opts.path) continue;
        events.push(ev);
      }
    }
    // Newest first, capped.
    events.reverse();
    return events.slice(0, limit);
  }

  /**
   * Summarise the whole journal (both files): total bytes on disk, all-time
   * event count, and the oldest/newest timestamps. Used for journal KPIs.
   * Bounded work — file sizes are capped by rotation.
   */
  async stats(): Promise<{ bytes: number; events: number; oldestMs: number | null; newestMs: number | null }> {
    let bytes = 0;
    let events = 0;
    let oldestMs: number | null = null;
    let newestMs: number | null = null;
    for (const f of [this.backup, this.file]) {
      let text: string;
      try {
        text = await readFile(f, "utf8");
      } catch {
        continue;
      }
      bytes += Buffer.byteLength(text);
      for (const raw of text.split("\n")) {
        if (!raw) continue;
        let ev: JournalEvent;
        try {
          ev = JSON.parse(raw) as JournalEvent;
        } catch {
          continue;
        }
        if (typeof ev.ts !== "number") continue;
        events++;
        if (oldestMs === null || ev.ts < oldestMs) oldestMs = ev.ts;
        if (newestMs === null || ev.ts > newestMs) newestMs = ev.ts;
      }
    }
    return { bytes, events, oldestMs, newestMs };
  }
}

/** Drop everything except the known, non-sensitive fields of an event. */
function sanitiseEvent(e: JournalEvent): JournalEvent {
  const out: JournalEvent = { ts: e.ts, kind: e.kind };
  if (typeof e.path === "string") out.path = e.path;
  if (typeof e.op === "string") out.op = e.op;
  if (typeof e.bytes === "number") out.bytes = e.bytes;
  if (typeof e.msg === "string") out.msg = e.msg.slice(0, 200);
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation (pure)
// ---------------------------------------------------------------------------

/**
 * Aggregate a list of events into the dashboard view. Pure and deterministic.
 *
 * @param events  Events to aggregate (any order).
 * @param nowMs   "Now" (epoch ms) — drives the window end.
 * @param days    Window size in calendar days (clamped 1–365).
 * @param topN    How many top paths to return (default 15).
 */
export function aggregateEvents(
  events: JournalEvent[],
  nowMs: number,
  days: number,
  topN = 15,
): JournalAggregate {
  const d = Math.max(1, Math.min(365, days));
  const toMs = nowMs - (nowMs % 86_400_000) + 86_400_000 - 1; // end of today (UTC)
  const fromMs = nowMs - (nowMs % 86_400_000) - (d - 1) * 86_400_000;

  const inWindow = events.filter((e) => e.ts >= fromMs && e.ts <= toMs);
  const ts = inWindow.map((e) => e.ts);

  const byKind: Record<string, number> = {};
  const pathCounts = new Map<string, number>();
  for (const e of inWindow) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    if (e.path) pathCounts.set(e.path, (pathCounts.get(e.path) ?? 0) + 1);
  }

  const topPaths = [...pathCounts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, topN);

  return {
    days: bucketByDay(ts, fromMs, toMs),
    byHour: bucketByHour(ts, fromMs, toMs),
    byKind,
    topPaths,
    total: inWindow.length,
    range: { fromMs, toMs },
  };
}

/** Compact summary of an arbitrary (already-filtered) event set, for drill-downs. */
export interface EventSummary {
  count: number;
  firstTs: number | null;
  lastTs: number | null;
  byKind: Record<string, number>;
  byOp: Record<string, number>;
  topPaths: { path: string; count: number }[];
}

/**
 * Summarise a filtered list of events for a drill-down detail view: count,
 * first/last timestamp, kind + op breakdowns, and the most-touched paths.
 *
 * @param events  Events to summarise (any order).
 * @param topN    How many top paths to include (default 10).
 */
export function summarizeEvents(events: JournalEvent[], topN = 10): EventSummary {
  const byKind: Record<string, number> = {};
  const byOp: Record<string, number> = {};
  const pathCounts = new Map<string, number>();
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    if (e.op) byOp[e.op] = (byOp[e.op] ?? 0) + 1;
    if (e.path) pathCounts.set(e.path, (pathCounts.get(e.path) ?? 0) + 1);
    if (firstTs === null || e.ts < firstTs) firstTs = e.ts;
    if (lastTs === null || e.ts > lastTs) lastTs = e.ts;
  }
  const topPaths = [...pathCounts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, topN);
  return { count: events.length, firstTs, lastTs, byKind, byOp, topPaths };
}
