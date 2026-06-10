/**
 * Secret detection & redaction.
 *
 * The `.claude` tree holds real secrets — OAuth tokens in `.credentials.json`,
 * API keys pasted into `history.jsonl`, bearer tokens in session transcripts.
 * Per the project's data-protection rules, sensitive data is **redacted by
 * default**; revealing the raw bytes is an explicit, deliberate user action.
 *
 * This module is intentionally conservative: it would rather over-redact a
 * harmless value than leak a live credential.
 */

/** Files whose entire contents are treated as sensitive (always redacted). */
const ALWAYS_SENSITIVE_BASENAMES = new Set<string>([
  ".credentials.json",
  "credentials.json",
  ".credentials",
]);

/** Path fragments that mark a file as sensitive regardless of contents. */
const SENSITIVE_PATH_HINTS = ["credential", "token", "secret", "/.ssh/"];

/** JSON keys whose string values get redacted. */
const SENSITIVE_KEY_RE =
  /(pass(word|phrase)?|secret|token|api[\s_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|authorization|auth[_-]?token|private[_-]?key|session[_-]?key|bearer|cookie|credential)/i;

/** Inline value patterns that look like live credentials in any text. */
const INLINE_SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // Anthropic-style keys.
  { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  // Generic OpenAI-style / sk- keys.
  { name: "sk-key", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  // GitHub tokens.
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  // JWTs (header.payload.signature).
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g },
  // AWS access key IDs.
  { name: "aws-akid", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Bearer headers.
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._-]{12,}/gi },
];

/** Placeholder shown in place of a redacted value. */
const MASK = "«redacted»";

/** Classify whether a file at `relPath` should be treated as wholly sensitive. */
export function isSensitivePath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  if (ALWAYS_SENSITIVE_BASENAMES.has(base)) return true;
  return SENSITIVE_PATH_HINTS.some((h) => lower.includes(h));
}

/**
 * Redact a text blob. Returns the possibly-modified text plus whether anything
 * was changed (so the UI can show a "contains redactions — reveal?" affordance).
 */
export function redactText(
  text: string,
  opts: { wholeFileSensitive: boolean } = { wholeFileSensitive: false },
): { text: string; redacted: boolean } {
  if (opts.wholeFileSensitive) {
    return { text: redactWholeFile(text), redacted: true };
  }
  let redacted = false;
  let out = text;

  // 1) Redact inline secret-looking tokens anywhere in the text FIRST, so a
  //    multi-word secret (e.g. "Bearer <token>") is masked as a whole before
  //    the key/value pass can consume just its first word.
  for (const { re } of INLINE_SECRET_PATTERNS) {
    out = out.replace(re, () => {
      redacted = true;
      return MASK;
    });
  }

  // 2) Redact JSON-ish "key": "value" pairs whose key looks sensitive.
  out = out.replace(
    /("?[\w.\- ]*?(?:pass(?:word|phrase)?|secret|token|api[\s_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|authorization|auth[_-]?token|private[_-]?key|session[_-]?key|bearer|cookie|credential)[\w.\- ]*"?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,}{]+)/gi,
    (_m, keyPart: string, valPart: string) => {
      redacted = true;
      const quote = valPart.startsWith('"') ? '"' : valPart.startsWith("'") ? "'" : "";
      return `${keyPart}${quote}${MASK}${quote}`;
    },
  );

  return { text: out, redacted };
}

/** Redact every primitive string/number value in a wholly-sensitive file. */
function redactWholeFile(text: string): string {
  // Try to keep JSON shape (so the UI can still show the structure) but mask
  // all leaf values. Fall back to a flat mask if it isn't valid JSON.
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(maskValues(parsed), null, 2);
  } catch {
    return MASK;
  }
}

/** Recursively replace every leaf value with the mask, preserving structure. */
function maskValues(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(maskValues);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskValues(v);
    }
    return out;
  }
  // Primitive leaf — mask it.
  return MASK;
}

/** Check whether a key (from a JSON object) is sensitive. Exposed for tests. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}
