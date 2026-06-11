/**
 * Dependency-free line-level diff using LCS (Myers-inspired patience-style).
 *
 * Produces a unified-diff–style sequence of hunks where each line is tagged as
 * context (`ctx`), an addition (`add`), or a deletion (`del`).  Useful for
 * comparing file-history snapshots without pulling in any npm package.
 */

/** One line in the output diff. */
export interface DiffLine {
  /** `ctx` = unchanged context line, `add` = added in b, `del` = deleted from a. */
  type: "ctx" | "add" | "del";
  /** The raw text of the line (no trailing newline). */
  text: string;
  /** 1-based line number in the "before" file (present for `ctx` and `del`). */
  aLine?: number;
  /** 1-based line number in the "after" file (present for `ctx` and `add`). */
  bLine?: number;
}

/**
 * Compute a line-level diff between two strings.
 *
 * The algorithm builds an LCS table over the split lines of `a` and `b`, then
 * back-traces to emit context, deletion, and addition rows.  Context lines are
 * trimmed to `contextLines` (default 3) on each side of a change, matching the
 * default behaviour of `diff -U3`.
 *
 * @param a            The "before" content.
 * @param b            The "after" content.
 * @param contextLines Number of surrounding unchanged lines to include (default 3).
 * @returns            Ordered array of {@link DiffLine} entries.
 *
 * @example
 * const lines = diffLines("hello\nworld\n", "hello\nearth\n");
 * // → [{type:"ctx",text:"hello",aLine:1,bLine:1},
 * //    {type:"del",text:"world",aLine:2},
 * //    {type:"add",text:"earth",bLine:2}]
 */
export function diffLines(a: string, b: string, contextLines = 3): DiffLine[] {
  const aLines = splitLines(a);
  const bLines = splitLines(b);

  // Fast path: identical content — no changes, so no diff lines.
  if (a === b) return [];

  // Build an LCS table.  For large files this is O(n*m) in both space and time.
  // Claude history files are typically source-code files of a few hundred KB,
  // so this is fine in practice; we cap at 5 000 lines each for safety.
  const aLen = Math.min(aLines.length, 5_000);
  const bLen = Math.min(bLines.length, 5_000);
  const dp = computeLcs(aLines, bLines, aLen, bLen);

  // Back-trace the LCS table and collect raw diff operations.
  const raw: Array<{ type: "ctx" | "add" | "del"; aIdx: number; bIdx: number }> = [];
  let i = aLen;
  let j = bLen;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      raw.push({ type: "ctx", aIdx: i - 1, bIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (dp[i]?.[j - 1] ?? 0) >= (dp[i - 1]?.[j] ?? 0))) {
      raw.push({ type: "add", aIdx: -1, bIdx: j - 1 });
      j--;
    } else {
      raw.push({ type: "del", aIdx: i - 1, bIdx: -1 });
      i--;
    }
  }
  raw.reverse();

  // Append any lines beyond the 5 000-line cap as additions (best effort).
  for (let k = aLen; k < aLines.length; k++) {
    raw.push({ type: "del", aIdx: k, bIdx: -1 });
  }
  for (let k = bLen; k < bLines.length; k++) {
    raw.push({ type: "add", aIdx: -1, bIdx: k });
  }

  // Convert raw ops to DiffLine entries with 1-based line numbers.
  const full: DiffLine[] = raw.map(({ type, aIdx, bIdx }) => {
    const entry: DiffLine = { type, text: "" };
    if (type === "ctx") {
      entry.text = aLines[aIdx] ?? "";
      entry.aLine = aIdx + 1;
      entry.bLine = bIdx + 1;
    } else if (type === "del") {
      entry.text = aLines[aIdx] ?? "";
      entry.aLine = aIdx + 1;
    } else {
      entry.text = bLines[bIdx] ?? "";
      entry.bLine = bIdx + 1;
    }
    return entry;
  });

  // Filter to contextLines around changes; if everything is context (unchanged)
  // return an empty diff to signal "no changes".
  return applyContext(full, contextLines);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Split content into lines, preserving empty trailing lines. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // `"a\n".split("\n")` yields `["a", ""]`; drop the empty sentinel.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Build the LCS dynamic-programming table for the first `aLen` × `bLen` lines.
 * Returns `dp` where `dp[i][j]` = length of LCS of `a[0..i)` and `b[0..j)`.
 */
function computeLcs(
  aLines: string[],
  bLines: string[],
  aLen: number,
  bLen: number,
): number[][] {
  // Allocate a 2-D array of zeroes.
  const dp: number[][] = Array.from({ length: aLen + 1 }, () =>
    new Array<number>(bLen + 1).fill(0),
  );
  for (let ii = 1; ii <= aLen; ii++) {
    for (let jj = 1; jj <= bLen; jj++) {
      if (aLines[ii - 1] === bLines[jj - 1]) {
        dp[ii]![jj] = (dp[ii - 1]![jj - 1] ?? 0) + 1;
      } else {
        dp[ii]![jj] = Math.max(dp[ii - 1]![jj] ?? 0, dp[ii]![jj - 1] ?? 0);
      }
    }
  }
  return dp;
}

/**
 * Trim a full diff to only show `contextLines` unchanged lines around each
 * changed region.  Returns an empty array when there are no changes at all.
 */
function applyContext(full: DiffLine[], ctx: number): DiffLine[] {
  // Mark which indices are "changed" (not ctx).
  const changed = full.map((l) => l.type !== "ctx");
  const keep = new Set<number>();
  for (let idx = 0; idx < full.length; idx++) {
    if (changed[idx]) {
      for (let k = Math.max(0, idx - ctx); k <= Math.min(full.length - 1, idx + ctx); k++) {
        keep.add(k);
      }
    }
  }
  if (keep.size === 0) return []; // no changes
  return full.filter((_, idx) => keep.has(idx));
}
