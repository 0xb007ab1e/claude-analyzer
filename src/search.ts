/**
 * Full-text search across the confined `.claude` tree.
 *
 * Walks the root (same confinement + skip-dirs as the rest of the app), reads
 * each *text* file line-by-line, and collects lines containing the query as a
 * **case-insensitive plain substring** (never a regex — avoids ReDoS on
 * user input). Every returned snippet is **redacted** with the same logic used
 * for file viewing, so a hit on a secret shows the mask, not the value
 * (master §5). Binary files are skipped.
 *
 * The work is bounded on every axis — files scanned, bytes/lines read per file,
 * hits per file, and total matches — so a broad query can't exhaust I/O or
 * memory; each cap sets a `truncated`/`capped` flag the UI surfaces rather than
 * silently returning partial results.
 *
 * Snippet windows are computed on grapheme-naive character offsets, which is
 * fine for a preview; the authoritative content is always the file itself.
 */

import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { safeResolveAsync, toRelative } from "./paths.ts";
import { TEXT_EXTENSIONS, extOf } from "./files.ts";
import { isSensitivePath, redactText } from "./redact.ts";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Directories never searched. */
const SKIP_DIRS = new Set([".git", ".analyzer-backups", "node_modules"]);
/** Maximum files visited before stopping with `scannedCapped`. */
const MAX_FILES_SCANNED = 20_000;
/** Maximum files that may appear in the results before stopping. */
const MAX_MATCH_FILES = 300;
/** Maximum total matches collected before stopping. */
const MAX_TOTAL_MATCHES = 1000;
/** Maximum hits kept per file (further hits increment `total` but aren't returned). */
const MAX_HITS_PER_FILE = 20;
/** Maximum lines read from any single file (bounds huge transcripts). */
const MAX_LINES_PER_FILE = 200_000;
/** Soft wall-clock budget (ms); when exceeded the scan stops with `truncated`. */
const DEADLINE_MS = 5000;
/** Snippet window (characters) kept around the first match position per line. */
const SNIPPET_RADIUS = 90;
/** Minimum query length (shorter queries are rejected to bound the result set). */
export const MIN_QUERY_LENGTH = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One matching line within a file. */
export interface SearchHit {
  /** 1-based line number. */
  line: number;
  /** Redacted, windowed snippet of the matching line. */
  snippet: string;
}

/** All hits for one file. */
export interface SearchFile {
  /** Root-relative forward-slash path. */
  path: string;
  /** Returned hits (≤ {@link MAX_HITS_PER_FILE}). */
  hits: SearchHit[];
  /** Total matching lines found (may exceed `hits.length`). */
  total: number;
  /** True if any returned snippet had something redacted. */
  redacted: boolean;
}

/** Result of {@link searchTreeText}. */
export interface SearchResult {
  query: string;
  files: SearchFile[];
  /** Number of files with ≥1 match. */
  matchedFiles: number;
  /** Total matching lines across all files. */
  totalMatches: number;
  /** Number of files actually read. */
  scanned: number;
  /** A cap was hit (results are partial). */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search the tree under `root` for `rawQuery`.
 *
 * @param root      Absolute, realpath'd root (confinement boundary).
 * @param rawQuery  The user's query (trimmed; matched case-insensitively).
 * @returns A {@link SearchResult}; `files` is empty when nothing matches.
 * @throws Error when the query is shorter than {@link MIN_QUERY_LENGTH}.
 */
export async function searchTreeText(root: string, rawQuery: string): Promise<SearchResult> {
  const query = rawQuery.trim();
  if (query.length < MIN_QUERY_LENGTH) {
    throw new SearchError(`query must be at least ${MIN_QUERY_LENGTH} characters`);
  }
  const needle = query.toLowerCase();

  const files: SearchFile[] = [];
  let totalMatches = 0;
  let scanned = 0;
  let truncated = false;
  const deadline = Date.now() + DEADLINE_MS;

  // BFS over directories, confined to root (pre-verified before enqueue).
  const queue: string[] = [root];
  outer: while (queue.length > 0) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
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
          safe = await safeResolveAsync(root, abs.slice(root.length + 1));
        } catch {
          continue;
        }
        queue.push(safe);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = toRelative(root, abs);
      if (!TEXT_EXTENSIONS.has(extOf(rel))) continue; // text files only

      if (scanned >= MAX_FILES_SCANNED || Date.now() > deadline) {
        truncated = true;
        break outer;
      }
      scanned++;

      const fileResult = await searchOneFile(abs, rel, needle);
      if (fileResult && fileResult.total > 0) {
        files.push(fileResult);
        totalMatches += fileResult.total;
        if (files.length >= MAX_MATCH_FILES || totalMatches >= MAX_TOTAL_MATCHES) {
          truncated = true;
          break outer;
        }
      }
    }
  }

  // Most-matches-first, then path for stable ordering.
  files.sort((a, b) => b.total - a.total || a.path.localeCompare(b.path));

  return { query, files, matchedFiles: files.length, totalMatches, scanned, truncated };
}

/** Search a single file by streaming its lines. Returns null on read error. */
async function searchOneFile(abs: string, rel: string, needle: string): Promise<SearchFile | null> {
  const wholeFileSensitive = isSensitivePath(rel);
  const hits: SearchHit[] = [];
  let total = 0;
  let anyRedacted = false;
  let lineNo = 0;

  let rl: ReturnType<typeof createInterface> | null = null;
  try {
    rl = createInterface({ input: createReadStream(abs, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      lineNo++;
      if (lineNo > MAX_LINES_PER_FILE) break;
      const idx = line.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      total++;
      if (hits.length < MAX_HITS_PER_FILE) {
        const { snippet, redacted } = makeSnippet(line, idx, needle.length, wholeFileSensitive);
        if (redacted) anyRedacted = true;
        hits.push({ line: lineNo, snippet });
      }
    }
  } catch {
    return null; // unreadable / vanished — skip
  } finally {
    rl?.close();
  }

  if (total === 0) return null;
  return { path: rel, hits, total, redacted: anyRedacted };
}

/**
 * Build a redacted snippet windowed around the match. Redaction runs on the
 * windowed text so secrets are masked even when only part of the line is shown.
 */
function makeSnippet(
  line: string,
  matchIdx: number,
  matchLen: number,
  wholeFileSensitive: boolean,
): { snippet: string; redacted: boolean } {
  let start = Math.max(0, matchIdx - SNIPPET_RADIUS);
  let end = Math.min(line.length, matchIdx + matchLen + SNIPPET_RADIUS);
  let window = line.slice(start, end);
  const { text, redacted } = redactText(window, { wholeFileSensitive });
  const prefix = start > 0 ? "…" : "";
  const suffix = end < line.length ? "…" : "";
  return { snippet: prefix + text + suffix, redacted: redacted || wholeFileSensitive };
}

/** A search input problem with a client-facing message. */
export class SearchError extends Error {}
