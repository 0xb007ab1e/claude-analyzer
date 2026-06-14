/**
 * Tiny fuzzy path matcher for the quick-open command palette.
 *
 * Subsequence matching: every character of the (lowercased) query must appear
 * in the path in order. The score rewards matches that are contiguous, fall on
 * a word boundary (`/ - _ .` or start), and land in the file's basename — so
 * "stjson" ranks `settings.json` above a path that merely contains those
 * letters scattered. Pure and synchronous, so it is fully unit-testable and
 * cheap enough to run over the whole (capped) path list per keystroke.
 */

/** Characters that mark a "word boundary" for the boundary bonus. */
const BOUNDARY = new Set(["/", "-", "_", ".", " "]);

/**
 * Score `path` against `query`. Returns a non-negative score when every query
 * character matches as an in-order subsequence, or -1 when it doesn't match.
 *
 * @param query  The search query (matched case-insensitively).
 * @param path   The candidate path.
 */
export function fuzzyScore(query: string, path: string): number {
  const q = query.toLowerCase();
  if (q === "") return 0;
  const s = path.toLowerCase();
  const baseStart = s.lastIndexOf("/") + 1; // 0 if no slash

  let qi = 0;
  let score = 0;
  let streak = 0;
  let prev = -2;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) continue;
    let pts = 1;
    if (prev === i - 1) {
      streak += 1;
      pts += streak * 2; // reward contiguous runs
    } else {
      streak = 0;
    }
    if (i === 0 || BOUNDARY.has(s[i - 1]!)) pts += 3; // word-boundary bonus
    if (i >= baseStart) pts += 2; // matches in the basename matter more
    score += pts;
    prev = i;
    qi += 1;
  }
  if (qi < q.length) return -1; // not all query chars matched

  // Prefer shorter paths slightly when scores are otherwise close.
  return score - s.length * 0.01;
}

/**
 * Rank `paths` by fuzzy score against `query`, returning the best `limit`.
 * An empty query returns the first `limit` paths in their existing order.
 *
 * @param query  The search query.
 * @param paths  Candidate paths.
 * @param limit  Maximum results (default 50).
 */
export function fuzzyRank(query: string, paths: string[], limit = 50): string[] {
  const cap = Math.max(1, limit);
  if (query.trim() === "") return paths.slice(0, cap);
  const scored: { path: string; score: number }[] = [];
  for (const p of paths) {
    const score = fuzzyScore(query, p);
    if (score >= 0) scored.push({ path: p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, cap).map((s) => s.path);
}
