/**
 * Tests for the live file-tree cache: build (text + binary, skip dirs),
 * incremental note() upsert/delete, TTL-driven rebuild, markStale, and the
 * paths()/mtimes() accessors.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TreeCache } from "../src/treecache.ts";

function tmpRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "ca-tree-")));
}

test("build indexes regular files and skips noise directories", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "a.txt"), "x");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "b.json"), "{}");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "ignored");
  mkdirSync(join(root, ".analyzer-backups"));
  writeFileSync(join(root, ".analyzer-backups", "old"), "ignored");

  const c = new TreeCache(root);
  await c.ensureFresh(1000);
  assert.deepEqual(c.paths().sort(), ["a.txt", "sub/b.json"]);
  assert.equal(c.size, 2);
  assert.equal(c.mtimes().length, 2);
});

test("note() upserts new files and removes deleted ones", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "a.txt"), "x");
  const c = new TreeCache(root);
  await c.ensureFresh(1000);
  assert.deepEqual(c.paths(), ["a.txt"]);

  writeFileSync(join(root, "new.md"), "hi");
  await c.note("new.md");
  assert.ok(c.paths().includes("new.md"));

  rmSync(join(root, "a.txt"));
  await c.note("a.txt");
  assert.ok(!c.paths().includes("a.txt"));
});

test("note() ignores changes inside skipped directories", async () => {
  const root = tmpRoot();
  const c = new TreeCache(root);
  await c.ensureFresh(1000);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref");
  await c.note(".git/HEAD");
  assert.equal(c.size, 0);
});

test("note() is a no-op for empty paths and directories", async () => {
  const root = tmpRoot();
  const c = new TreeCache(root);
  await c.ensureFresh(1000);
  await c.note(""); // empty — ignored
  assert.equal(c.size, 0);
  mkdirSync(join(root, "adir"));
  await c.note("adir"); // a directory, not a file — not indexed
  assert.equal(c.size, 0);
});

test("note() on a path that never existed leaves the cache unchanged", async () => {
  const root = tmpRoot();
  const c = new TreeCache(root);
  await c.ensureFresh(1000);
  await c.note("ghost.txt"); // stat throws ENOENT → delete (already absent)
  assert.equal(c.size, 0);
});

test("ensureFresh rebuilds only after the TTL elapses", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "a.txt"), "x");
  const c = new TreeCache(root, { ttlMs: 1000 });
  await c.ensureFresh(0);
  assert.equal(c.size, 1);

  // Add a file directly (bypassing note) — a within-TTL read does NOT rebuild.
  writeFileSync(join(root, "b.txt"), "y");
  await c.ensureFresh(500);
  assert.equal(c.size, 1, "should still be cached within TTL");

  // Past the TTL, the next read rebuilds and picks up b.txt.
  await c.ensureFresh(2000);
  assert.equal(c.size, 2);
});

test("markStale forces a rebuild on the next read", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "a.txt"), "x");
  const c = new TreeCache(root, { ttlMs: 1_000_000 });
  await c.ensureFresh(0);
  assert.equal(c.size, 1);

  writeFileSync(join(root, "b.txt"), "y");
  c.markStale();
  await c.ensureFresh(1); // would normally be within TTL, but stale forces rebuild
  assert.equal(c.size, 2);
});
