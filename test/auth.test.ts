/**
 * Tests for the bearer-token auth helpers: constant-time match, token
 * extraction (header vs query), and the authorize decision (incl. the
 * auth-disabled fast path and fail-closed behaviour).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenMatches, presentedToken, isAuthorized } from "../src/auth.ts";

test("tokenMatches is true only for an exact match", () => {
  assert.equal(tokenMatches("s3cret", "s3cret"), true);
  assert.equal(tokenMatches("s3cret", "S3CRET"), false);
  assert.equal(tokenMatches("s3cret", "s3cre"), false);
  assert.equal(tokenMatches("s3cretX", "s3cret"), false);
  assert.equal(tokenMatches("", "s3cret"), false);
  assert.equal(tokenMatches(null, "s3cret"), false);
  assert.equal(tokenMatches(undefined, "s3cret"), false);
  assert.equal(tokenMatches("s3cret", ""), false);
});

test("presentedToken reads a Bearer header (case-insensitive) or query value", () => {
  assert.equal(presentedToken("Bearer abc123", null), "abc123");
  assert.equal(presentedToken("bearer   abc123  ", null), "abc123");
  assert.equal(presentedToken(undefined, "qtok"), "qtok");
  // Header wins when both are present.
  assert.equal(presentedToken("Bearer hdr", "qtok"), "hdr");
  // Non-bearer header falls through to the query value.
  assert.equal(presentedToken("Basic xyz", "qtok"), "qtok");
  assert.equal(presentedToken(undefined, null), null);
  assert.equal(presentedToken("Bearer ", null), null);
});

test("isAuthorized: disabled when no token configured", () => {
  assert.equal(isAuthorized(null, undefined, null), true);
  assert.equal(isAuthorized(null, "Bearer whatever", null), true);
});

test("isAuthorized: requires a matching token when configured", () => {
  assert.equal(isAuthorized("good", "Bearer good", null), true);
  assert.equal(isAuthorized("good", undefined, "good"), true); // via query
  assert.equal(isAuthorized("good", "Bearer bad", null), false);
  assert.equal(isAuthorized("good", undefined, null), false); // fail closed
  assert.equal(isAuthorized("good", undefined, "bad"), false);
});
