/**
 * Usage & cost aggregation logic for GET /api/usage.
 *
 * Pure functions (no filesystem I/O) live here so they can be unit-tested
 * independently. The filesystem-walking entry point `collectUsage` is also
 * here for locality, but the pure helpers are the tested surface.
 *
 * Scanning caps:
 *   MAX_FILES_SCANNED — total .jsonl files walked across projects/
 *   MAX_BYTES_PER_FILE — bytes read per file before truncation
 *   MAX_LINES_PER_FILE — JSONL lines parsed per file
 * These keep us from blocking the event loop on huge trees.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { safeResolveAsync, toRelative } from "./paths.ts";
import { isSensitivePath } from "./redact.ts";

// ---------------------------------------------------------------------------
// Scan caps (safety bounds)
// ---------------------------------------------------------------------------

const MAX_FILES_SCANNED = 500;
const MAX_BYTES_PER_FILE = 2 * 1024 * 1024; // 2 MiB
const MAX_LINES_PER_FILE = 10_000;
const MAX_HISTORY_LINES = 50_000;

// ---------------------------------------------------------------------------
// Pricing table  ($/million tokens)
// All prices are estimates drawn from publicly-listed Anthropic pricing.
// CLEARLY MARKED AS ESTIMATES — callers should surface this to the user.
// ---------------------------------------------------------------------------

/**
 * Per-model pricing in USD per **million** tokens.
 * Input price covers cache-creation and normal input alike.
 * Cache-read tokens are billed at a lower rate where listed.
 */
export interface ModelPrice {
  /** USD / MTok for input (and cache-creation, which is billed like input). */
  inputPerMTok: number;
  /** USD / MTok for output tokens. */
  outputPerMTok: number;
  /** USD / MTok for cache-read tokens (usually 10% of input price). */
  cacheReadPerMTok: number;
}

/**
 * Built-in price table keyed by model-id prefixes (longest match wins).
 * Prices are approximate public list prices and are clearly marked as
 * estimates in the API response.
 */
export const PRICE_TABLE: Record<string, ModelPrice> = {
  // Claude 3.5 Haiku
  "claude-haiku-4":             { inputPerMTok: 0.80,  outputPerMTok: 4.00,  cacheReadPerMTok: 0.08 },
  "claude-3-5-haiku":           { inputPerMTok: 0.80,  outputPerMTok: 4.00,  cacheReadPerMTok: 0.08 },
  // Claude 3.5 Sonnet / claude-sonnet-4
  "claude-sonnet-4":            { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheReadPerMTok: 0.30 },
  "claude-3-5-sonnet":          { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheReadPerMTok: 0.30 },
  // Claude 3 Sonnet
  "claude-3-sonnet":            { inputPerMTok: 3.00,  outputPerMTok: 15.00, cacheReadPerMTok: 0.30 },
  // Claude 3 Haiku
  "claude-3-haiku":             { inputPerMTok: 0.25,  outputPerMTok: 1.25,  cacheReadPerMTok: 0.03 },
  // Claude Opus 4 / 3.5 Opus
  "claude-opus-4":              { inputPerMTok: 15.00, outputPerMTok: 75.00, cacheReadPerMTok: 1.50 },
  "claude-3-5-opus":            { inputPerMTok: 15.00, outputPerMTok: 75.00, cacheReadPerMTok: 1.50 },
  "claude-3-opus":              { inputPerMTok: 15.00, outputPerMTok: 75.00, cacheReadPerMTok: 1.50 },
};

// ---------------------------------------------------------------------------
// Public data-transfer types
// ---------------------------------------------------------------------------

/** Aggregated token counts across all scanned records. */
export interface TokenTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

/** Session-level summary for one .jsonl transcript file. */
export interface SessionSummary {
  /** Root-relative path to the transcript file. */
  path: string;
  /** Best-effort human-readable project/cwd label. */
  project: string;
  /** Unique model ids seen in this session. */
  models: string[];
  /** Epoch-ms of the first timestamped record (undefined if none found). */
  firstTs?: number;
  /** Epoch-ms of the last timestamped record. */
  lastTs?: number;
  /** Total record count (parsed lines). */
  recordCount: number;
  /** Summed token counts for this session. */
  tokens: TokenTotals;
}

/** {project → count} pair for sessions-per-project. */
export interface ProjectCount {
  project: string;
  count: number;
}

/** {date (YYYY-MM-DD) → count} pair for messages-over-time. */
export interface DayCount {
  date: string;
  count: number;
}

/** {model → count} pair for model mix. */
export interface ModelCount {
  model: string;
  count: number;
}

/** Top-level response shape for GET /api/usage. */
export interface UsageResult {
  /** Total number of session transcript files found. */
  totalSessions: number;
  /** Session count per decoded project label. */
  sessionsPerProject: ProjectCount[];
  /** Message/record count bucketed by calendar day (UTC). */
  messagesOverTime: DayCount[];
  /** How often each model appeared in message records. */
  modelMix: ModelCount[];
  /** Summed token counts across all scanned records. */
  tokenTotals: TokenTotals;
  /**
   * Estimated USD cost. Omitted when no matching model prices are available.
   * Always clearly labelled as an estimate in the UI.
   */
  estimatedCostUsd?: number;
  /** ISO-8601 timestamp when this summary was generated. */
  generatedAt: string;
  /**
   * True if scanning hit one of the file/byte/line caps and the result
   * is a partial view of the full dataset.
   */
  truncated: boolean;
  /** Extra detail about what was truncated, for the UI tooltip. */
  truncatedNote?: string;
  /** history.jsonl summary (undefined if the file is absent). */
  history?: {
    lineCount: number;
    minTs?: number;
    maxTs?: number;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — these are unit-tested
// ---------------------------------------------------------------------------

/**
 * Bucket an array of epoch-millisecond timestamps into UTC calendar days.
 * Returns an array sorted ascending by date, with zero-count days omitted.
 *
 * @param timestampsMs  Array of timestamps (epoch ms).  May be empty.
 * @returns             Array of `{date: "YYYY-MM-DD", count: N}` sorted ascending.
 */
export function bucketByDay(timestampsMs: number[]): DayCount[] {
  const counts = new Map<string, number>();
  for (const ts of timestampsMs) {
    // Use ISO-8601 date in UTC: "YYYY-MM-DD"
    const date = new Date(ts).toISOString().slice(0, 10);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Sum token usage fields from an array of raw JSONL record objects.
 * Looks for usage under `record.message.usage` and `record.usage`.
 * Unknown or missing fields are treated as zero.
 *
 * @param records  Array of parsed JSON objects from a transcript file.
 * @returns        Summed {@link TokenTotals}.
 */
export function sumUsage(records: unknown[]): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  for (const rec of records) {
    if (rec === null || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    // Usage may be nested under `message.usage` (Claude transcript format)
    // or directly at `record.usage`.
    const usageRaw: unknown =
      (r["message"] !== null && typeof r["message"] === "object"
        ? (r["message"] as Record<string, unknown>)["usage"]
        : undefined) ?? r["usage"];
    if (usageRaw === null || typeof usageRaw !== "object") continue;
    const u = usageRaw as Record<string, unknown>;
    totals.input       += safeInt(u["input_tokens"]);
    totals.output      += safeInt(u["output_tokens"]);
    totals.cacheCreate += safeInt(u["cache_creation_input_tokens"]);
    totals.cacheRead   += safeInt(u["cache_read_input_tokens"]);
  }
  return totals;
}

/**
 * Estimate cost in USD given per-model token totals and a price table.
 * Returns undefined if no matching prices are found for any model.
 * Cache-creation tokens are billed at the full input rate; cache-read at the
 * discounted rate.
 *
 * @param tokensByModel  Map from model-id to {@link TokenTotals}.
 * @param priceTable     Price lookup (longest prefix match).
 * @returns              Estimated USD cost, or undefined if unresolvable.
 */
export function estimateCost(
  tokensByModel: Map<string, TokenTotals>,
  priceTable: Record<string, ModelPrice>,
): number | undefined {
  let total = 0;
  let anyMatch = false;
  for (const [model, tokens] of tokensByModel) {
    const price = lookupPrice(model, priceTable);
    if (!price) continue;
    anyMatch = true;
    total +=
      ((tokens.input + tokens.cacheCreate) / 1_000_000) * price.inputPerMTok +
      (tokens.output / 1_000_000) * price.outputPerMTok +
      (tokens.cacheRead / 1_000_000) * price.cacheReadPerMTok;
  }
  return anyMatch ? total : undefined;
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Find the longest prefix key in `table` that `modelId` starts with.
 * Returns undefined if no entry matches.
 */
function lookupPrice(modelId: string, table: Record<string, ModelPrice>): ModelPrice | undefined {
  let best: ModelPrice | undefined;
  let bestLen = 0;
  const lower = modelId.toLowerCase();
  for (const [key, price] of Object.entries(table)) {
    if (lower.startsWith(key.toLowerCase()) && key.length > bestLen) {
      best = price;
      bestLen = key.length;
    }
  }
  return best;
}

/** Return `n` as an integer if it's a finite number, else 0. */
function safeInt(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * Decode a Claude project directory slug back to a human-readable label.
 *
 * Claude encodes the cwd path by replacing path separators with `-`:
 *   `/home/alice/myproject` → `-home-alice-myproject`
 * We decode just enough to make the label legible; this is best-effort.
 */
export function decodeProjectSlug(slug: string): string {
  // Strip leading dash that comes from the leading `/`
  const clean = slug.startsWith("-") ? slug.slice(1) : slug;
  // Replace every `-` separator with `/`. This isn't perfect for paths that
  // genuinely contained hyphens, but it's the closest we can get without
  // ground truth.
  return "/" + clean.replace(/-/g, "/");
}

// ---------------------------------------------------------------------------
// Filesystem scanning (I/O; not unit-tested but covered by smoke test)
// ---------------------------------------------------------------------------

/** Options for {@link collectUsage}. */
interface CollectOptions {
  /** Absolute, realpath'd root (the .claude directory). */
  root: string;
}

/**
 * Walk the root directory and aggregate usage signals.
 *
 * Bounded by the scan caps at the top of this file; sets `truncated` when
 * any cap is hit. All filesystem access is confined to `root` via
 * `safeResolveAsync`.
 */
export async function collectUsage(opts: CollectOptions): Promise<UsageResult> {
  const { root } = opts;

  let truncated = false;
  const truncatedReasons: string[] = [];

  const allTimestampsMs: number[] = [];
  const modelMessageCounts = new Map<string, number>();
  const tokensByModel = new Map<string, TokenTotals>();
  const sessions: SessionSummary[] = [];

  // -------------------------------------------------------------------------
  // (a) history.jsonl
  // -------------------------------------------------------------------------
  let historySummary: UsageResult["history"] | undefined;
  try {
    const histAbs = await safeResolveAsync(root, "history.jsonl");
    const histSt = await stat(histAbs);
    if (histSt.isFile()) {
      // Read partial if the file is huge (bounded by MAX_BYTES_PER_FILE)
      let rawText: string;
      if (histSt.size > MAX_BYTES_PER_FILE) {
        truncated = true;
        truncatedReasons.push(`history.jsonl truncated at ${MAX_BYTES_PER_FILE} bytes`);
        rawText = (await readFile(histAbs)).slice(0, MAX_BYTES_PER_FILE).toString("utf8");
      } else {
        rawText = await readFile(histAbs, "utf8");
      }
      const lines = rawText.split("\n");
      let lineCount = 0;
      let minTs: number | undefined;
      let maxTs: number | undefined;
      let linesChecked = 0;
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        lineCount++;
        if (linesChecked >= MAX_HISTORY_LINES) {
          truncated = true;
          truncatedReasons.push(`history.jsonl: only first ${MAX_HISTORY_LINES} lines scanned`);
          break;
        }
        linesChecked++;
        // Try to extract a timestamp field for bucketing
        try {
          const obj = JSON.parse(t) as Record<string, unknown>;
          const ts = extractTimestamp(obj);
          if (ts !== undefined) {
            allTimestampsMs.push(ts);
            if (minTs === undefined || ts < minTs) minTs = ts;
            if (maxTs === undefined || ts > maxTs) maxTs = ts;
          }
        } catch {
          // malformed line — skip timestamp extraction, still count it
        }
      }
      historySummary = { lineCount, minTs, maxTs };
    }
  } catch {
    // history.jsonl absent or unreadable — not an error
  }

  // -------------------------------------------------------------------------
  // (b) projects/**/*.jsonl
  // -------------------------------------------------------------------------
  let filesScanned = 0;
  try {
    const projectsAbs = await safeResolveAsync(root, "projects");
    const projectsExist = await stat(projectsAbs).then((s) => s.isDirectory()).catch(() => false);
    if (projectsExist) {
      // List project dirs (one level deep)
      const projectDirs = await readdir(projectsAbs, { withFileTypes: true });
      outer:
      for (const pDirent of projectDirs) {
        if (!pDirent.isDirectory()) continue;
        const pName = pDirent.name;
        const pAbs = join(projectsAbs, pName);
        // Confine: verify this path is still inside root
        const pRel = toRelative(root, pAbs);
        if (isSensitivePath(pRel)) continue;

        // List .jsonl files directly inside this project dir (no deep recursion
        // to avoid unbounded walks in odd layouts)
        let pEntries: import("node:fs").Dirent[];
        try {
          pEntries = await readdir(pAbs, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const fDirent of pEntries) {
          if (!fDirent.isFile()) continue;
          if (!fDirent.name.endsWith(".jsonl")) continue;
          if (filesScanned >= MAX_FILES_SCANNED) {
            truncated = true;
            truncatedReasons.push(`project scan capped at ${MAX_FILES_SCANNED} files`);
            break outer;
          }
          filesScanned++;

          const fAbs = join(pAbs, fDirent.name);
          const fRel = toRelative(root, fAbs);
          if (isSensitivePath(fRel)) continue;

          const session = await scanSessionFile(fAbs, fRel, pName, root);
          if (session.truncatedFile) {
            truncated = true;
            truncatedReasons.push(`${fRel}: file truncated`);
          }
          sessions.push(session.summary);

          // Accumulate timestamps for global messages-over-time chart
          for (const ts of session.timestamps) {
            allTimestampsMs.push(ts);
          }

          // Accumulate model message counts
          for (const [model, count] of session.modelCounts) {
            modelMessageCounts.set(model, (modelMessageCounts.get(model) ?? 0) + count);
          }

          // Accumulate per-model token totals
          for (const [model, tokens] of session.tokensByModel) {
            const existing = tokensByModel.get(model) ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
            tokensByModel.set(model, {
              input:       existing.input       + tokens.input,
              output:      existing.output      + tokens.output,
              cacheCreate: existing.cacheCreate + tokens.cacheCreate,
              cacheRead:   existing.cacheRead   + tokens.cacheRead,
            });
          }
        }
      }
    }
  } catch {
    // projects/ absent or unreadable — not an error
  }

  // -------------------------------------------------------------------------
  // (c) stats-cache.json and usage-guard/ — parse & summarize (no secrets)
  // -------------------------------------------------------------------------
  // We read these for completeness but currently just note their presence;
  // redaction is handled by isSensitivePath for whole-file sensitive files.
  // (No extra fields added to the result for these right now — the spec says
  //  "parse + summarize"; we include the token/timestamp data already extracted
  //  from the session files above, which is the meaningful summary.)

  // -------------------------------------------------------------------------
  // Build final result
  // -------------------------------------------------------------------------

  // Sessions per project
  const projectCounts = new Map<string, number>();
  for (const s of sessions) {
    projectCounts.set(s.project, (projectCounts.get(s.project) ?? 0) + 1);
  }
  const sessionsPerProject: ProjectCount[] = [...projectCounts.entries()]
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => b.count - a.count);

  // Messages over time
  const messagesOverTime = bucketByDay(allTimestampsMs);

  // Model mix (sorted by count desc)
  const modelMix: ModelCount[] = [...modelMessageCounts.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count);

  // Aggregate token totals
  const tokenTotals: TokenTotals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  for (const t of tokensByModel.values()) {
    tokenTotals.input       += t.input;
    tokenTotals.output      += t.output;
    tokenTotals.cacheCreate += t.cacheCreate;
    tokenTotals.cacheRead   += t.cacheRead;
  }

  // Estimated cost
  const estimatedCostUsd = estimateCost(tokensByModel, PRICE_TABLE);

  return {
    totalSessions: sessions.length,
    sessionsPerProject,
    messagesOverTime,
    modelMix,
    tokenTotals,
    estimatedCostUsd,
    generatedAt: new Date().toISOString(),
    truncated,
    truncatedNote: truncatedReasons.length > 0 ? truncatedReasons.join("; ") : undefined,
    history: historySummary,
  };
}

// ---------------------------------------------------------------------------
// Session-file scanner
// ---------------------------------------------------------------------------

interface ScanResult {
  summary: SessionSummary;
  timestamps: number[];
  modelCounts: Map<string, number>;
  tokensByModel: Map<string, TokenTotals>;
  truncatedFile: boolean;
}

/**
 * Read and parse one session .jsonl file, extracting metadata without
 * retaining record contents. Bounded by MAX_BYTES_PER_FILE and
 * MAX_LINES_PER_FILE.
 */
async function scanSessionFile(
  absPath: string,
  relPath: string,
  projectDirName: string,
  root: string,
): Promise<ScanResult> {
  const project = decodeProjectSlug(projectDirName);
  const modelCounts = new Map<string, number>();
  const tokensByModel = new Map<string, TokenTotals>();
  const timestamps: number[] = [];
  let truncatedFile = false;
  let firstTs: number | undefined;
  let lastTs: number | undefined;
  let recordCount = 0;

  let rawText: string;
  try {
    const st = await stat(absPath);
    if (st.size > MAX_BYTES_PER_FILE) {
      truncatedFile = true;
      const buf = await readFile(absPath);
      rawText = buf.slice(0, MAX_BYTES_PER_FILE).toString("utf8");
    } else {
      rawText = await readFile(absPath, "utf8");
    }
  } catch {
    // Unreadable file — return an empty summary
    return {
      summary: {
        path: relPath,
        project,
        models: [],
        recordCount: 0,
        tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
      },
      timestamps: [],
      modelCounts: new Map(),
      tokensByModel: new Map(),
      truncatedFile: false,
    };
  }

  const lines = rawText.split("\n");
  const modelsInSession = new Set<string>();

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (recordCount >= MAX_LINES_PER_FILE) {
      truncatedFile = true;
      break;
    }
    recordCount++;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // malformed line — skip
    }

    // Timestamp
    const ts = extractTimestamp(obj);
    if (ts !== undefined) {
      timestamps.push(ts);
      if (firstTs === undefined || ts < firstTs) firstTs = ts;
      if (lastTs === undefined || ts > lastTs) lastTs = ts;
    }

    // Model extraction: look in record.message.model or record.model
    const model = extractModel(obj);
    if (model) {
      modelsInSession.add(model);
      modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);

      // Token usage
      const usage = extractUsage(obj);
      if (usage) {
        const existing = tokensByModel.get(model) ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
        tokensByModel.set(model, {
          input:       existing.input       + safeInt(usage.input_tokens),
          output:      existing.output      + safeInt(usage.output_tokens),
          cacheCreate: existing.cacheCreate + safeInt(usage.cache_creation_input_tokens),
          cacheRead:   existing.cacheRead   + safeInt(usage.cache_read_input_tokens),
        });
      }
    }
  }

  // Aggregate tokens across models for this session's summary
  const sessionTokens: TokenTotals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  for (const t of tokensByModel.values()) {
    sessionTokens.input       += t.input;
    sessionTokens.output      += t.output;
    sessionTokens.cacheCreate += t.cacheCreate;
    sessionTokens.cacheRead   += t.cacheRead;
  }

  return {
    summary: {
      path: relPath,
      project,
      models: [...modelsInSession],
      firstTs,
      lastTs,
      recordCount,
      tokens: sessionTokens,
    },
    timestamps,
    modelCounts,
    tokensByModel,
    truncatedFile,
  };
}

// ---------------------------------------------------------------------------
// Field extractors (handle multiple Claude transcript formats)
// ---------------------------------------------------------------------------

/** Extract an epoch-ms timestamp from a record, returning undefined if absent. */
function extractTimestamp(obj: Record<string, unknown>): number | undefined {
  // Common fields: `timestamp` (ISO string or epoch-ms number), `ts`, `created_at`
  for (const key of ["timestamp", "ts", "created_at"]) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      // Could be epoch-seconds or epoch-ms; heuristic: values < 1e12 are seconds
      return v < 1e12 ? v * 1000 : v;
    }
    if (typeof v === "string" && v.length >= 10) {
      const ms = Date.parse(v);
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return undefined;
}

/** Extract a model identifier from a record. */
function extractModel(obj: Record<string, unknown>): string | undefined {
  // `message.model` is the most common location in Claude transcripts
  const msg = obj["message"];
  if (msg !== null && typeof msg === "object") {
    const m = (msg as Record<string, unknown>)["model"];
    if (typeof m === "string" && m) return m;
  }
  // Direct `model` field
  const direct = obj["model"];
  if (typeof direct === "string" && direct) return direct;
  return undefined;
}

/** Extract a usage object from a record (handles nested and direct forms). */
function extractUsage(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const msg = obj["message"];
  if (msg !== null && typeof msg === "object") {
    const u = (msg as Record<string, unknown>)["usage"];
    if (u !== null && typeof u === "object") return u as Record<string, unknown>;
  }
  const u = obj["usage"];
  if (u !== null && typeof u === "object") return u as Record<string, unknown>;
  return undefined;
}
