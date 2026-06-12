/**
 * Tests for source-dir resolution — ensures no machine-specific path is baked
 * in and that --source / CLAUDE_SRC / missing-dir behave deterministically.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "../src/config.ts";

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

test("token: defaults to null (auth disabled)", () => {
  const cfg = loadConfig(["--root", tmpDir()], {});
  assert.equal(cfg.token, null);
});

test("token: CA_TOKEN env takes precedence over --token", () => {
  const cfg = loadConfig(["--root", tmpDir(), "--token", "fromflag"], { CA_TOKEN: "fromenv" });
  assert.equal(cfg.token, "fromenv");
});

test("token: --token-file is read and trimmed", () => {
  const root = tmpDir();
  const file = join(root, "tok");
  writeFileSync(file, "  filetoken\n");
  const cfg = loadConfig(["--root", root, "--token-file", file], {});
  assert.equal(cfg.token, "filetoken");
});

test("token: blank/whitespace value disables auth", () => {
  const cfg = loadConfig(["--root", tmpDir(), "--token", "   "], {});
  assert.equal(cfg.token, null);
});

test("token: an unreadable --token-file fails fast", () => {
  const root = tmpDir();
  assert.throws(() => loadConfig(["--root", root, "--token-file", join(root, "missing")], {}), ConfigError);
});
