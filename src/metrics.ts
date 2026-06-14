/**
 * In-process application metrics (RED: Rate, Errors, Duration).
 *
 * A tiny, dependency-free counter store for the server's own behaviour —
 * requests by route + status class, request latency (count/sum/max + a
 * fixed-bucket histogram for percentile estimates), and a handful of named
 * event counters (reveals, writes, restores, filesystem changes, errors).
 *
 * The logic is pure and synchronous: `Metrics` holds plain numbers and the
 * helpers ({@link routeLabel}, {@link percentile}) are exported for unit tests.
 * `snapshot()` takes an explicit `nowMs` so output is deterministic in tests.
 *
 * Cardinality is bounded on purpose: routes are normalised to a small fixed set
 * of labels (see {@link routeLabel}) so an attacker spraying random URLs can't
 * grow memory without bound.
 */

/**
 * Upper bounds (inclusive, milliseconds) of the latency histogram buckets. A
 * request with duration `d` falls in the first bucket whose bound is `>= d`;
 * anything slower than the last bound lands in an implicit overflow bucket.
 */
export const LATENCY_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000] as const;

/** Per-route request tally exposed in a snapshot. */
interface RouteStat {
  /** Total requests routed to this label. */
  count: number;
  /** Count by HTTP status class (key = "2xx" | "3xx" | "4xx" | "5xx"). */
  byClass: Record<string, number>;
  /** Mean request latency for this route (ms). */
  avgMs: number;
  /** Slowest request observed for this route (ms). */
  maxMs: number;
}

/** Internal mutable per-route accumulator (sums kept for averaging). */
interface RouteAccum {
  count: number;
  byClass: Record<string, number>;
  sumMs: number;
  maxMs: number;
}

/** A point-in-time, JSON-serialisable view of all metrics. */
export interface MetricsSnapshot {
  /** Per-process boot id (matches the SSE `hello` event). */
  bootId: string;
  /** Server start time (epoch ms) and uptime derived from `nowMs`. */
  startMs: number;
  uptimeMs: number;
  /** Resident set size in bytes at snapshot time (0 if unavailable). */
  rssBytes: number;
  /** Total requests served. */
  requests: number;
  /** Requests by status class. */
  byClass: Record<string, number>;
  /** Requests by normalised route label. */
  byRoute: Record<string, RouteStat>;
  /** Overall error rate (4xx + 5xx over total), 0–1. */
  errorRate: number;
  /** Latency summary in milliseconds. */
  latency: {
    count: number;
    avgMs: number;
    maxMs: number;
    /** Estimated percentiles from the histogram (upper-bound of the bucket). */
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    /** Histogram bucket counts, aligned with {@link LATENCY_BUCKETS_MS} plus overflow. */
    buckets: { leMs: number | null; count: number }[];
  };
  /** Named event counters (reveals, writes, restores, fschange, errors, …). */
  counters: Record<string, number>;
}

/**
 * Normalise a request method + path into a small, stable route label so metric
 * cardinality stays bounded regardless of query strings or unknown URLs.
 *
 * @param method  HTTP method (used only to disambiguate read vs write on /api/file).
 * @param path    URL pathname (no query string).
 * @returns A label like `GET /api/file`, `static`, or `other`.
 */
export function routeLabel(method: string, path: string): string {
  const m = method.toUpperCase();
  // Known API endpoints — list explicitly to cap cardinality.
  const apiRoutes = new Set([
    "/api/config",
    "/api/settings",
    "/api/list",
    "/api/usage",
    "/api/search",
    "/api/activity",
    "/api/projects",
    "/api/paths",
    "/api/audit",
    "/api/file",
    "/api/diff",
    "/api/file-lines",
    "/api/raw",
    "/api/history/list",
    "/api/history/entry",
    "/api/history/restore",
    "/api/extensions",
    "/api/xref",
    "/api/graph",
    "/api/events",
    "/api/metrics",
    "/api/observability",
    "/api/journal",
  ]);
  if (apiRoutes.has(path)) return `${m} ${path}`;
  if (path === "/" || !path.startsWith("/api/")) return "static";
  return "other";
}

/** Status-class bucket key ("2xx"…"5xx", or "1xx") for an HTTP status code. */
export function statusClass(status: number): string {
  const c = Math.floor(status / 100);
  return c >= 1 && c <= 5 ? `${c}xx` : "other";
}

/**
 * Estimate a percentile (0–1) from histogram bucket counts. Returns the upper
 * bound (ms) of the bucket the percentile falls into; the overflow bucket
 * reports the last finite bound (a conservative lower estimate for the tail).
 *
 * @param buckets  Counts aligned with {@link LATENCY_BUCKETS_MS} plus one overflow.
 * @param q        Quantile in [0,1].
 */
export function percentile(buckets: number[], q: number): number {
  const total = buckets.reduce((s, n) => s + n, 0);
  if (total === 0) return 0;
  const target = q * total;
  let cum = 0;
  for (let i = 0; i < buckets.length; i++) {
    cum += buckets[i] ?? 0;
    if (cum >= target) {
      return LATENCY_BUCKETS_MS[i] ?? LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1]!;
    }
  }
  return LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1]!;
}

/**
 * Mutable metrics store. One instance per server process. All methods are
 * synchronous and cheap; call them from the request hot path freely.
 */
export class Metrics {
  readonly #bootId: string;
  readonly #startMs: number;
  #requests = 0;
  #byClass: Record<string, number> = {};
  #byRoute = new Map<string, RouteAccum>();
  #latCount = 0;
  #latSum = 0;
  #latMax = 0;
  // One slot per LATENCY_BUCKETS_MS bound, plus a trailing overflow slot.
  #latBuckets = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);
  #counters = new Map<string, number>();

  /**
   * @param bootId   Per-process id (for correlating with the SSE hello event).
   * @param startMs  Process start time (epoch ms).
   */
  constructor(bootId: string, startMs: number) {
    this.#bootId = bootId;
    this.#startMs = startMs;
  }

  /** Record one completed request. */
  recordRequest(routeLbl: string, status: number, durationMs: number): void {
    this.#requests++;
    const cls = statusClass(status);
    this.#byClass[cls] = (this.#byClass[cls] ?? 0) + 1;

    const d = durationMs >= 0 ? durationMs : 0;

    let r = this.#byRoute.get(routeLbl);
    if (!r) {
      r = { count: 0, byClass: {}, sumMs: 0, maxMs: 0 };
      this.#byRoute.set(routeLbl, r);
    }
    r.count++;
    r.byClass[cls] = (r.byClass[cls] ?? 0) + 1;
    r.sumMs += d;
    if (d > r.maxMs) r.maxMs = d;

    this.#latCount++;
    this.#latSum += d;
    if (d > this.#latMax) this.#latMax = d;
    this.#latBuckets[this.#bucketIndex(d)]!++;
  }

  /** Increment a named counter (e.g. "reveal", "write", "fschange", "error"). */
  incr(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  /** Index of the latency bucket a duration falls into. */
  #bucketIndex(ms: number): number {
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      if (ms <= LATENCY_BUCKETS_MS[i]!) return i;
    }
    return LATENCY_BUCKETS_MS.length; // overflow
  }

  /** Build a JSON-serialisable snapshot. `nowMs` drives uptime deterministically. */
  snapshot(nowMs: number, rssBytes = 0): MetricsSnapshot {
    const byRoute: Record<string, RouteStat> = {};
    for (const [k, v] of this.#byRoute) {
      byRoute[k] = {
        count: v.count,
        byClass: { ...v.byClass },
        avgMs: v.count > 0 ? v.sumMs / v.count : 0,
        maxMs: v.maxMs,
      };
    }
    const errors = (this.#byClass["4xx"] ?? 0) + (this.#byClass["5xx"] ?? 0);
    const buckets = this.#latBuckets.map((count, i) => ({
      leMs: i < LATENCY_BUCKETS_MS.length ? LATENCY_BUCKETS_MS[i]! : null,
      count,
    }));
    return {
      bootId: this.#bootId,
      startMs: this.#startMs,
      uptimeMs: Math.max(0, nowMs - this.#startMs),
      rssBytes,
      requests: this.#requests,
      byClass: { ...this.#byClass },
      byRoute,
      errorRate: this.#requests > 0 ? errors / this.#requests : 0,
      latency: {
        count: this.#latCount,
        avgMs: this.#latCount > 0 ? this.#latSum / this.#latCount : 0,
        maxMs: this.#latMax,
        p50Ms: percentile(this.#latBuckets, 0.5),
        p95Ms: percentile(this.#latBuckets, 0.95),
        p99Ms: percentile(this.#latBuckets, 0.99),
        buckets,
      },
      counters: Object.fromEntries(this.#counters),
    };
  }
}
