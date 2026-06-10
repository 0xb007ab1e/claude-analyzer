/**
 * Path confinement utilities.
 *
 * SECURITY-CRITICAL: every filesystem access in this app must go through
 * {@link safeResolve}. The whole app is a read/write window onto a single root
 * directory; the one thing it must never do is let a request escape that root
 * (path traversal — CWE-22). These functions fail closed: on any doubt they
 * throw {@link PathError} rather than return a possibly-unsafe path.
 */

import { realpath } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep, dirname, relative } from "node:path";

/** Raised when a requested path is rejected (escapes root, invalid, etc.). */
export class PathError extends Error {
  /** HTTP-ish status to surface to the client (always a 4xx — client fault). */
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PathError";
    this.status = status;
  }
}

/**
 * Return true if `child` is the same path as `parent` or nested within it.
 *
 * Both inputs must already be absolute & normalized. Uses a trailing-separator
 * guard so `/a/bc` is NOT considered inside `/a/b`.
 */
export function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolve a client-supplied relative path against `root`, guaranteeing the
 * result stays inside `root` even in the presence of symlinks.
 *
 * @param root     Absolute, already-realpath'd root directory.
 * @param relPath  Untrusted relative path from the client ("" or "." => root).
 * @returns        The resolved absolute path (confined to root).
 * @throws {PathError} if the input is absolute, contains a null byte, or the
 *   resolved target (or its nearest existing ancestor, for not-yet-created
 *   files) lies outside `root`.
 */
export function safeResolve(root: string, relPath: string): string {
  if (typeof relPath !== "string") throw new PathError("path must be a string");
  if (relPath.includes("\0")) throw new PathError("path contains null byte");

  // Leading slashes are web-style: "/foo" means root-relative, not the
  // filesystem root. Stripping them means absolute-looking input is always
  // reinterpreted *inside* root and can never escape — the confinement check
  // below is what actually enforces safety.
  const cleaned = relPath.replace(/^[/\\]+/, "");
  if (cleaned === "" || cleaned === ".") return root;

  const target = resolve(root, cleaned);

  // Lexical check first (cheap, catches plain ../ traversal).
  if (!isInside(root, target)) {
    throw new PathError("path escapes the configured root", 403);
  }

  // Symlink check: realpath the deepest existing portion and re-verify.
  // For a path that doesn't exist yet (a file about to be written) we check
  // its nearest existing ancestor, so a symlinked parent can't smuggle us out.
  const existingAncestor = nearestExisting(target);
  let realAncestor: string;
  try {
    realAncestor = realpathSync(existingAncestor);
  } catch {
    throw new PathError("path could not be resolved", 400);
  }
  if (!isInside(root, realAncestor)) {
    throw new PathError("path escapes the configured root via symlink", 403);
  }

  return target;
}

/** Async variant of {@link safeResolve} (uses async realpath). */
export async function safeResolveAsync(root: string, relPath: string): Promise<string> {
  // The logic is identical; we only swap the realpath call for the async one so
  // the hot request path doesn't block the event loop on slow filesystems.
  const lexical = safeResolveLexical(root, relPath);
  if (lexical === root) return root;
  const existingAncestor = nearestExisting(lexical);
  let realAncestor: string;
  try {
    realAncestor = await realpath(existingAncestor);
  } catch {
    throw new PathError("path could not be resolved", 400);
  }
  if (!isInside(root, realAncestor)) {
    throw new PathError("path escapes the configured root via symlink", 403);
  }
  return lexical;
}

/** Lexical-only resolution + confinement (no symlink/realpath check). */
function safeResolveLexical(root: string, relPath: string): string {
  if (typeof relPath !== "string") throw new PathError("path must be a string");
  if (relPath.includes("\0")) throw new PathError("path contains null byte");
  const cleaned = relPath.replace(/^[/\\]+/, "");
  if (cleaned === "" || cleaned === ".") return root;
  const target = resolve(root, cleaned);
  if (!isInside(root, target)) {
    throw new PathError("path escapes the configured root", 403);
  }
  return target;
}

/** Walk up from `p` until we find a path that exists on disk. */
function nearestExisting(p: string): string {
  let cur = p;
  // Bounded loop: at worst we reach the filesystem root.
  for (let i = 0; i < 4096; i++) {
    if (existsSync(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return cur; // reached fs root
    cur = parent;
  }
  return cur;
}

/** Compute the root-relative path for display (always uses forward slashes). */
export function toRelative(root: string, absPath: string): string {
  const rel = relative(root, absPath);
  return rel.split(sep).join("/");
}

/** Join a root-relative dir and a child name into a new root-relative path. */
export function relJoin(dir: string, name: string): string {
  return join(dir, name).split(sep).join("/");
}
