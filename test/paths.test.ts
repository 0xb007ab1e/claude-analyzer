/**
 * Tests for path confinement — the app's primary security boundary.
 * These cover the critical path and must stay at 100%.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeResolve, isInside, PathError, toRelative } from "../src/paths.ts";

function makeRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "analyzer-test-")));
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "settings.json"), "{}");
  writeFileSync(join(dir, "sub", "a.txt"), "hi");
  return dir;
}

test("resolves a normal nested path inside root", () => {
  const root = makeRoot();
  assert.equal(safeResolve(root, "sub/a.txt"), join(root, "sub", "a.txt"));
  assert.equal(safeResolve(root, "settings.json"), join(root, "settings.json"));
});

test("empty / '.' / leading-slash map to root", () => {
  const root = makeRoot();
  assert.equal(safeResolve(root, ""), root);
  assert.equal(safeResolve(root, "."), root);
  assert.equal(safeResolve(root, "/"), root);
  assert.equal(safeResolve(root, "/settings.json"), join(root, "settings.json"));
});

test("rejects ../ traversal", () => {
  const root = makeRoot();
  assert.throws(() => safeResolve(root, "../escape"), PathError);
  assert.throws(() => safeResolve(root, "sub/../../escape"), PathError);
  assert.throws(() => safeResolve(root, "../../etc/passwd"), PathError);
});

test("reinterprets absolute-looking input as confined (never escapes)", () => {
  const root = makeRoot();
  // A leading slash is web-style root-relative, so "/etc/passwd" can only ever
  // resolve *inside* root — it cannot reach the real /etc/passwd.
  const resolved = safeResolve(root, "/etc/passwd");
  assert.equal(resolved, join(root, "etc", "passwd"));
  assert.equal(resolved.startsWith(root), true);
});

test("rejects null bytes", () => {
  const root = makeRoot();
  assert.throws(() => safeResolve(root, "a\0b"), PathError);
});

test("rejects a symlink that points outside root", () => {
  const root = makeRoot();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "analyzer-outside-")));
  writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  assert.throws(() => safeResolve(root, "link.txt"), PathError);
});

test("rejects writing through a symlinked directory that escapes root", () => {
  const root = makeRoot();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "analyzer-outside2-")));
  symlinkSync(outside, join(root, "evil"));
  // New file under the symlinked dir would land outside root — must be rejected.
  assert.throws(() => safeResolve(root, "evil/newfile.txt"), PathError);
});

test("allows a not-yet-existing file under a real directory", () => {
  const root = makeRoot();
  assert.equal(safeResolve(root, "sub/new.json"), join(root, "sub", "new.json"));
});

test("isInside trailing-separator guard", () => {
  assert.equal(isInside("/a/b", "/a/b"), true);
  assert.equal(isInside("/a/b", "/a/b/c"), true);
  assert.equal(isInside("/a/b", "/a/bc"), false);
  assert.equal(isInside("/a/b", "/a"), false);
});

test("toRelative produces forward-slash relative paths", () => {
  const root = makeRoot();
  assert.equal(toRelative(root, join(root, "sub", "a.txt")), "sub/a.txt");
  assert.equal(toRelative(root, root), "");
});
