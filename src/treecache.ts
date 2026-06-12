/**
 * In-memory file-tree cache (path → mtime), kept live by the filesystem watcher.
 *
 * The full-tree analytical views — the relationship graph (`/api/graph`) and the
 * activity timeline (`/api/activity`) — previously re-walked the entire root on
 * every request (a recursive `readdir` + a `stat` per file, capped at 20k). On a
 * large `.claude` that's real latency on each open. This cache walks once, then
 * the server feeds it the same `fschange` events it already broadcasts so the
 * cache stays current incrementally — no per-request full walk.
 *
 * Safety nets against watcher drift (missed inotify events, recursive-watch
 * failure): a TTL triggers a full rebuild after {@link DEFAULT_TTL_MS}, and the
 * server calls {@link TreeCache.markStale} on a watch error to force a rebuild
 * on the next request. Correctness is never sacrificed for speed — a stale read
 * is bounded by the TTL and self-heals.
 *
 * Stores only **regular files** (not directories/symlinks), matching what the
 * graph/activity walks counted. `nowMs` is passed in so freshness logic is
 * deterministic and unit-testable.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { safeResolveAsync, toRelative } from "./paths.ts";

/** Directories never indexed (matches the rest of the app). */
const SKIP_DIRS = new Set([".git", ".analyzer-backups", "node_modules"]);
/** Cap on cached entries; beyond this the cache reports `truncated`. */
const MAX_ENTRIES = 50_000;
/** Default freshness window before a full rebuild is forced (5 min). */
export const DEFAULT_TTL_MS = 5 * 60_000;

/** Path → mtime index of the tree, maintained incrementally from fs events. */
export class TreeCache {
  readonly root: string;
  readonly #ttlMs: number;
  #map = new Map<string, number>(); // root-relative path → mtimeMs
  #built = false;
  #builtAtMs = 0;
  #building: Promise<void> | null = null;
  #truncated = false;

  /**
   * @param root  Absolute, realpath'd root (confinement boundary).
   * @param opts.ttlMs  Freshness window before a forced rebuild.
   */
  constructor(root: string, opts: { ttlMs?: number } = {}) {
    this.root = root;
    this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Ensure the cache is fresh enough to read: rebuild if never built or older
   * than the TTL. Concurrent callers share one in-flight rebuild.
   *
   * @param nowMs  Current time (epoch ms).
   */
  async ensureFresh(nowMs: number): Promise<void> {
    if (this.#built && nowMs - this.#builtAtMs <= this.#ttlMs) return;
    if (this.#building) return this.#building;
    this.#building = this.#build(nowMs).finally(() => {
      this.#building = null;
    });
    return this.#building;
  }

  /** Force the next {@link ensureFresh} to rebuild (e.g. after a watch error). */
  markStale(): void {
    this.#built = false;
  }

  /**
   * Apply one filesystem change. Stats the path to decide: a regular file is
   * upserted with its mtime; anything else (gone, or now a directory) is
   * removed. Never throws — observability/caching must not break the watcher.
   *
   * @param rel  Root-relative, forward-slash path from the watch event.
   */
  async note(rel: string): Promise<void> {
    if (!rel || isSkipped(rel)) return;
    let abs: string;
    try {
      abs = await safeResolveAsync(this.root, rel);
    } catch {
      this.#map.delete(rel); // escaped root / unresolvable — ensure it's gone
      return;
    }
    try {
      const st = await stat(abs);
      if (st.isFile()) {
        if (!this.#map.has(rel) && this.#map.size >= MAX_ENTRIES) {
          this.#truncated = true;
          return;
        }
        this.#map.set(rel, st.mtimeMs);
      } else {
        this.#map.delete(rel);
      }
    } catch {
      this.#map.delete(rel); // vanished
    }
  }

  /** Cached root-relative file paths (order unspecified). */
  paths(): string[] {
    return [...this.#map.keys()];
  }

  /** Cached file mtimes (epoch ms). */
  mtimes(): number[] {
    return [...this.#map.values()];
  }

  /** Number of cached files. */
  get size(): number {
    return this.#map.size;
  }

  /** True if a cap was hit during build or incremental updates. */
  get truncated(): boolean {
    return this.#truncated;
  }

  /** Full walk into a fresh map, then atomically swap it in. */
  async #build(nowMs: number): Promise<void> {
    const next = new Map<string, number>();
    let truncated = false;
    const queue: string[] = [this.root];

    outer: while (queue.length > 0) {
      const dir = queue.shift()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          let safe: string;
          try {
            safe = await safeResolveAsync(this.root, abs.slice(this.root.length + 1));
          } catch {
            continue;
          }
          queue.push(safe);
        } else if (entry.isFile()) {
          if (next.size >= MAX_ENTRIES) {
            truncated = true;
            break outer;
          }
          try {
            next.set(toRelative(this.root, abs), (await stat(abs)).mtimeMs);
          } catch {
            // raced away between readdir and stat — skip
          }
        }
      }
    }

    this.#map = next;
    this.#truncated = truncated;
    this.#builtAtMs = nowMs;
    this.#built = true;
  }
}

/** True if a root-relative path lies in a skipped directory. */
function isSkipped(rel: string): boolean {
  const first = rel.split("/", 1)[0] ?? "";
  if (SKIP_DIRS.has(first)) return true;
  for (const d of SKIP_DIRS) {
    if (rel.includes(`/${d}/`)) return true;
  }
  return false;
}
