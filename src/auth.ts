/**
 * Optional bearer-token authentication for the API surface.
 *
 * When a token is configured (`CA_TOKEN` / `--token-file` / `--token`), every
 * `/api/*` request must present it — defense in depth on top of the Host
 * allowlist so the server is safe to reach over Tailscale/LAN, not just
 * loopback. Static assets (the non-sensitive SPA shell) are served freely; the
 * UI prompts for the token when an API call returns 401.
 *
 * The token may arrive as an `Authorization: Bearer <token>` header (normal
 * fetches) or a `?token=` query parameter (for `EventSource` and `<img>/<embed>`
 * `src`, which can't set headers). Comparison is **constant-time** (both sides
 * hashed to equal-length digests) to avoid leaking the token via timing.
 *
 * Pure and dependency-light (only `node:crypto`), so it is fully unit-testable.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality. Both inputs are SHA-256'd first so the
 * comparison operates on fixed-length buffers regardless of input length
 * (`timingSafeEqual` throws on length mismatch otherwise).
 */
export function tokenMatches(presented: string | null | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Extract the presented token from an Authorization header or a query value.
 *
 * @param authHeader  The request's `authorization` header (may be undefined).
 * @param queryToken  The `token` query-string value (may be null).
 * @returns The token string, or null if none was supplied.
 */
export function presentedToken(
  authHeader: string | undefined,
  queryToken: string | null,
): string | null {
  if (typeof authHeader === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (m && m[1]) return m[1].trim();
  }
  if (queryToken) return queryToken;
  return null;
}

/**
 * Decide whether a request is authorized.
 *
 * @param expected     The configured token, or null when auth is disabled.
 * @param authHeader   The request `authorization` header.
 * @param queryToken   The `token` query-string value.
 * @returns true if auth is disabled (no expected token) or the presented token
 *          matches; false otherwise. Fails closed on any mismatch.
 */
export function isAuthorized(
  expected: string | null,
  authHeader: string | undefined,
  queryToken: string | null,
): boolean {
  if (!expected) return true; // auth disabled
  return tokenMatches(presentedToken(authHeader, queryToken), expected);
}
