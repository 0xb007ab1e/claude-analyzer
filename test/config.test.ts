/**
 * Tests for source-dir resolution — ensures no machine-specific path is baked
 * in and that --source / CLAUDE_SRC / missing-dir behave deterministically.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

function tmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "ca-config-")));
}

test("--source resolves to the realpath'd directory", () => {
  const root = tmpDir();
  const src = tmpDir();
  const cfg = loadConfig(["--root", root, "--source", src], {});
  assert.equal(cfg.sourceDir, src);
});

test("CLAUDE_SRC env sets the source dir when no flag is given", () => {
  const root = tmpDir();
  const src = tmpDir();
  const cfg = loadConfig(["--root", root], { CLAUDE_SRC: src });
  assert.equal(cfg.sourceDir, src);
});

test("--source overrides CLAUDE_SRC", () => {
  const root = tmpDir();
  const flagSrc = tmpDir();
  const envSrc = tmpDir();
  const cfg = loadConfig(["--root", root, "--source", flagSrc], { CLAUDE_SRC: envSrc });
  assert.equal(cfg.sourceDir, flagSrc);
});

test("a non-existent source path degrades to null (feature stays off)", () => {
  const root = tmpDir();
  const cfg = loadConfig(["--root", root, "--source", join(root, "nope-not-here")], {});
  assert.equal(cfg.sourceDir, null);
});
