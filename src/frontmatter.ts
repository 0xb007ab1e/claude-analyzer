/**
 * YAML-ish frontmatter parser for Claude agent / skill / command `.md` files.
 *
 * ## What it handles
 * - A file that starts with a `---` delimiter line, followed by zero or more
 *   `key: value` lines, closed by another `---` line.  Everything after the
 *   closing `---` is the body.
 * - Files that have no frontmatter block: returns `frontmatter: {}` and the
 *   whole text as body.
 *
 * ## Value types parsed
 * - **Quoted strings** — `key: "a b"` or `key: 'a b'` → string.
 * - **Block scalars** (`>-`, `>`, `|-`, `|`) — the indented continuation lines
 *   that follow are joined into a single string.  `>` / `>-` collapse newlines
 *   to spaces (folded); `|` / `|-` preserve newlines (literal).
 * - **Inline lists** — `key: [a, b, c]` → string[].
 * - **Bare values** — `key: simple value` → trimmed string.
 * - **Nested objects one level deep** — a key with no value followed by
 *   indented `subkey: val` lines → `{ subkey: val, … }`.
 * - `true` / `false` / integers and simple numbers are left as strings (the
 *   callers treat all frontmatter values as display data).
 *
 * ## Limits (documented)
 * - No multi-document YAML.
 * - No anchors, aliases, tags, or flow mappings.
 * - Nesting beyond one level deep is not parsed; the raw lines are kept as-is
 *   under the parent key as a single newline-joined string.
 * - Lists are only parsed in inline `[…]` form; block sequence (`- item`) is
 *   kept as a raw string.
 * - YAML comments (#) on the same line as a value are left in the value string.
 *
 * This is intentionally minimal: it handles the real shapes present in
 * `~/.claude/agents/{star}.md` and `~/.claude/skills/{name}/SKILL.md` and nothing more.
 */

/** A parsed frontmatter value: a string, a list of strings, or a nested object. */
export type FrontmatterValue = string | string[] | Record<string, string>;

/** Result of {@link parseFrontmatter}. */
export interface ParsedFrontmatter {
  /** Key→value map extracted from the `--- … ---` block. `{}` if none found. */
  frontmatter: Record<string, FrontmatterValue>;
  /** Everything after the closing `---` delimiter (or the whole text if none). */
  body: string;
}

/**
 * Parse YAML-ish frontmatter from a Markdown text.
 *
 * @param text  Raw file text (UTF-8).
 * @returns     `{ frontmatter, body }` — see {@link ParsedFrontmatter}.
 *
 * @example
 * ```ts
 * const { frontmatter, body } = parseFrontmatter(
 *   "---\nname: foo\ndescription: >-\n  A folded\n  string\n---\n# Body\n"
 * );
 * // frontmatter.name === "foo"
 * // frontmatter.description === "A folded string"
 * // body starts with "# Body"
 * ```
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const lines = text.split("\n");

  // The first non-empty line must be exactly `---` for a frontmatter block to
  // exist.  We skip leading blank lines for robustness.
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i >= lines.length || lines[i]!.trim() !== "---") {
    return { frontmatter: {}, body: text };
  }
  i++; // skip opening ---

  // Collect raw frontmatter lines until the closing `---`.
  const fmLines: string[] = [];
  let closedAt = -1;
  for (; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      closedAt = i;
      break;
    }
    fmLines.push(lines[i]!);
  }

  if (closedAt === -1) {
    // No closing delimiter — treat the whole file as body, no frontmatter.
    return { frontmatter: {}, body: text };
  }

  const body = lines.slice(closedAt + 1).join("\n");
  const frontmatter = parseMapping(fmLines);
  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Internal: parse a flat sequence of YAML-ish mapping lines.
// ---------------------------------------------------------------------------

/**
 * Parse an array of raw frontmatter lines (between the `---` delimiters) into
 * a flat key→value record.
 */
function parseMapping(lines: string[]): Record<string, FrontmatterValue> {
  const out: Record<string, FrontmatterValue> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Skip blank lines and comment-only lines.
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    // A top-level key: must not be indented (no leading whitespace, or minimal).
    // We detect it by looking for `key:` at indent level 0 or 2 spaces or less.
    const indent = leadingSpaces(line);
    if (indent > 2) {
      // Continuation line without a key context — skip.
      i++;
      continue;
    }

    const colonAt = line.indexOf(":");
    if (colonAt <= 0) {
      i++;
      continue;
    }

    const key = line.slice(indent, colonAt).trim();
    if (!key) {
      i++;
      continue;
    }

    const afterColon = line.slice(colonAt + 1);
    const afterTrimmed = afterColon.trimStart();
    i++;

    // Block scalar: `>-`, `>`, `|-`, `|`
    if (/^[>|][-+]?\s*$/.test(afterTrimmed) || /^[>|][-+]?(\s+#.*)?$/.test(afterTrimmed)) {
      const folded = afterTrimmed.startsWith(">") || afterTrimmed.trimStart().startsWith(">");
      const [val, consumed] = readBlockScalar(lines, i, folded);
      out[key] = val;
      i += consumed;
      continue;
    }

    // Inline list: `[a, b, c]`
    if (afterTrimmed.startsWith("[")) {
      out[key] = parseInlineList(afterTrimmed);
      continue;
    }

    // Empty value → look ahead for an indented sub-mapping.
    if (afterTrimmed === "") {
      const [sub, consumed] = readSubMapping(lines, i);
      if (consumed > 0) {
        out[key] = sub;
        i += consumed;
      }
      // else: key with no value and no sub-map — leave as empty string.
      continue;
    }

    // Plain (bare) or quoted value.
    out[key] = parseScalarValue(afterTrimmed);
  }

  return out;
}

/**
 * Read a YAML block scalar (folded `>` or literal `|`).
 *
 * @param lines   All frontmatter lines.
 * @param start   Index of the first *content* line (the line after `key: >`).
 * @param folded  `true` for `>` (collapse newlines), `false` for `|` (preserve).
 * @returns       `[joined-string, lines-consumed]`
 */
function readBlockScalar(lines: string[], start: number, folded: boolean): [string, number] {
  const parts: string[] = [];
  let consumed = 0;
  // Detect indentation from the first non-blank continuation line.
  let baseIndent = -1;

  for (let j = start; j < lines.length; j++) {
    const l = lines[j]!;
    if (l.trim() === "") {
      parts.push("");
      consumed++;
      continue;
    }
    const ind = leadingSpaces(l);
    if (baseIndent === -1) baseIndent = ind;
    // If indentation drops to or below the parent key's level (0–2 spaces),
    // we've left the block.
    if (ind < baseIndent) break;
    parts.push(l.slice(baseIndent));
    consumed++;
  }

  // Trim trailing blanks (strip-chomping, `-`).
  while (parts.length > 0 && parts[parts.length - 1]!.trim() === "") {
    parts.pop();
  }

  const joined = folded ? parts.join(" ").replace(/\s+/g, " ").trim() : parts.join("\n").trim();
  return [joined, consumed];
}

/**
 * Read an indented sub-mapping (one level of nesting).
 *
 * @param lines  All frontmatter lines.
 * @param start  First line to inspect.
 * @returns      `[sub-object, lines-consumed]`
 */
function readSubMapping(lines: string[], start: number): [Record<string, string>, number] {
  const sub: Record<string, string> = {};
  let consumed = 0;

  for (let j = start; j < lines.length; j++) {
    const l = lines[j]!;
    if (l.trim() === "") {
      consumed++;
      continue;
    }
    const ind = leadingSpaces(l);
    // Sub-mapping keys must be indented by at least 2 spaces.
    if (ind < 2) break;
    const colonAt = l.indexOf(":");
    if (colonAt <= ind) {
      consumed++;
      continue;
    }
    const subKey = l.slice(ind, colonAt).trim();
    const subVal = parseScalarValue(l.slice(colonAt + 1).trimStart());
    if (subKey) sub[subKey] = String(subVal);
    consumed++;
  }

  return [sub, consumed];
}

/**
 * Parse an inline list `[a, "b c", d]` into a string array.
 * Handles simple quoting and commas; does not support nested lists.
 */
function parseInlineList(raw: string): string[] {
  const inner = raw.replace(/^\[/, "").replace(/\].*$/, "");
  if (!inner.trim()) return [];
  const items: string[] = [];
  // Split on commas, but not inside quoted strings.
  let cur = "";
  let inQ: string | null = null;
  for (const ch of inner) {
    if (inQ) {
      if (ch === inQ) inQ = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      inQ = ch;
    } else if (ch === ",") {
      const t = cur.trim();
      if (t) items.push(t);
      cur = "";
    } else {
      cur += ch;
    }
  }
  const last = cur.trim();
  if (last) items.push(last);
  return items;
}

/**
 * Parse a bare or quoted scalar: strips surrounding quotes if present,
 * otherwise returns trimmed string as-is.
 */
function parseScalarValue(raw: string): string {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Count the number of leading space characters (tabs count as 1 each). */
function leadingSpaces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " " || ch === "\t") n++;
    else break;
  }
  return n;
}
