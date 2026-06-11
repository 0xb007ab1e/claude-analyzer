/**
 * Tests for the source cross-reference search logic.
 *
 * Uses a small temporary fixture tree so the tests are hermetic and fast
 * (no dependency on any real external directory). Covers the pure walk/search
 * logic in src/xref.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchTree } from "../src/xref.ts";

/** Create a temp dir and return its realpath. */
function tmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "xref-test-")));
}

/** Write a file, creating parent directories as needed. */
function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

// ---------------------------------------------------------------------------
// Basic search
// ---------------------------------------------------------------------------

test("finds a token in a simple text file", async () => {
  const root = tmpDir();
  write(root, "src/main.ts", "// This reads settings.json\nconst x = 1;\n");

  const result = await searchTree(root, "settings.json");
  assert.equal(result.available, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]!.file, "src/main.ts");
  assert.equal(result.matches[0]!.hits.length, 1);
  assert.equal(result.matches[0]!.hits[0]!.line, 1);
  assert.ok(result.matches[0]!.hits[0]!.text.includes("settings.json"));
  assert.equal(result.totalMatches, 1);
  assert.equal(result.truncated, false);
});

test("finds a token across multiple files", async () => {
  const root = tmpDir();
  write(root, "a.ts", "// reads hooks.json\n");
  write(root, "b.ts", "// also hooks.json here\n");
  write(root, "c.ts", "// nothing relevant\n");

  const result = await searchTree(root, "hooks.json");
  assert.equal(result.available, true);
  const files = result.matches.map((m) => m.file).sort();
  assert.deepEqual(files, ["a.ts", "b.ts"]);
  assert.equal(result.totalMatches, 2);
});

test("returns empty result when no matches found", async () => {
  const root = tmpDir();
  write(root, "src/a.ts", "const x = 42;\n");

  const result = await searchTree(root, "NONEXISTENT_TOKEN_XYZ");
  assert.equal(result.available, true);
  assert.equal(result.matches.length, 0);
  assert.equal(result.totalMatches, 0);
  assert.equal(result.truncated, false);
});

test("finds multiple hits on different lines of the same file", async () => {
  const root = tmpDir();
  write(root, "f.ts", "const a = MYTOKEN;\nconst b = 2;\nconst c = MYTOKEN;\n");

  const result = await searchTree(root, "MYTOKEN");
  assert.equal(result.matches.length, 1);
  const hits = result.matches[0]!.hits;
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.line, 1);
  assert.equal(hits[1]!.line, 3);
});

// ---------------------------------------------------------------------------
// Skip directories
// ---------------------------------------------------------------------------

test("skips node_modules", async () => {
  const root = tmpDir();
  write(root, "node_modules/pkg/index.js", "// SKIPME\n");
  write(root, "src/index.ts", "// SKIPME is here\n");

  const result = await searchTree(root, "SKIPME");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]!.file, "src/index.ts");
});

test("skips .git directory", async () => {
  const root = tmpDir();
  write(root, ".git/COMMIT_EDITMSG", "TOKEN_GIT");
  write(root, "main.ts", "TOKEN_GIT is here\n");

  const result = await searchTree(root, "TOKEN_GIT");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]!.file, "main.ts");
});

test("skips dist and build directories", async () => {
  const root = tmpDir();
  write(root, "dist/bundle.js", "const BUILT = true; // DISTTOKEN\n");
  write(root, "build/out.js", "// DISTTOKEN\n");
  write(root, "src/index.ts", "// DISTTOKEN in source\n");

  const result = await searchTree(root, "DISTTOKEN");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]!.file, "src/index.ts");
});

// ---------------------------------------------------------------------------
// Skip binary / oversized files
// ---------------------------------------------------------------------------

test("skips files with binary extension (.jpg)", async () => {
  const root = tmpDir();
  // Write file with .jpg extension — even if it has text content, binary ext wins.
  const imgPath = join(root, "photo.jpg");
  mkdirSync(root, { recursive: true });
  writeFileSync(imgPath, "IMAGETOKEN data here");

  const result = await searchTree(root, "IMAGETOKEN");
  assert.equal(result.matches.length, 0);
});

test("skips files with NUL bytes (binary sniffing)", async () => {
  const root = tmpDir();
  // Write a file with an unknown extension that contains a NUL byte.
  const binPath = join(root, "data.unknown");
  writeFileSync(binPath, Buffer.from([0x42, 0x49, 0x4e, 0x00, 0x41, 0x52, 0x59])); // BIN\0ARY

  const result = await searchTree(root, "BINAR");
  assert.equal(result.matches.length, 0);
});

test("skips files exceeding maxFileBytes", async () => {
  const root = tmpDir();
  // Create a file that is exactly 1 byte over the limit.
  const bigPath = join(root, "big.ts");
  const limit = 512; // use a small limit in the test
  writeFileSync(bigPath, "BIGTOKEN\n".repeat(100));

  // Use a very small limit to force the skip.
  const result = await searchTree(root, "BIGTOKEN", { maxFileBytes: limit });
  assert.equal(result.matches.length, 0);
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

test("truncates at maxHits and sets truncated=true", async () => {
  const root = tmpDir();
  // Write 20 lines, each matching the token, and cap at 5 hits.
  write(root, "a.ts", Array.from({ length: 20 }, (_, i) => `const v${i} = TRUNCTOKEN;`).join("\n") + "\n");

  const result = await searchTree(root, "TRUNCTOKEN", { maxHits: 5 });
  assert.equal(result.truncated, true);
  assert.equal(result.totalMatches, 5);
});

test("does not truncate when under the limit", async () => {
  const root = tmpDir();
  write(root, "a.ts", "EXACTTOKEN\nEXACTTOKEN\n");

  const result = await searchTree(root, "EXACTTOKEN", { maxHits: 10 });
  assert.equal(result.truncated, false);
  assert.equal(result.totalMatches, 2);
});

// ---------------------------------------------------------------------------
// Hit text truncation
// ---------------------------------------------------------------------------

test("truncates individual hit lines at maxHitText", async () => {
  const root = tmpDir();
  const longLine = "const x = LONGTOKEN_" + "a".repeat(300) + ";";
  write(root, "a.ts", longLine + "\n");

  const result = await searchTree(root, "LONGTOKEN_", { maxHitText: 50 });
  assert.equal(result.matches.length, 1);
  const hitText = result.matches[0]!.hits[0]!.text;
  assert.ok(hitText.length <= 51); // 50 chars + "…"
  assert.ok(hitText.endsWith("…"));
});

// ---------------------------------------------------------------------------
// File path formatting
// ---------------------------------------------------------------------------

test("returns forward-slash paths relative to source root", async () => {
  const root = tmpDir();
  write(root, "deep/nested/dir/file.ts", "// PATHTOKEN\n");

  const result = await searchTree(root, "PATHTOKEN");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]!.file, "deep/nested/dir/file.ts");
});

// ---------------------------------------------------------------------------
// Symlink confinement
// ---------------------------------------------------------------------------

test("does not follow symlinks outside the source root", async () => {
  const root = tmpDir();
  const outside = tmpDir();
  writeFileSync(join(outside, "secret.ts"), "// SYMLINK_SECRET\n");
  // Symlink pointing outside root.
  symlinkSync(join(outside, "secret.ts"), join(root, "evil.ts"));

  const result = await searchTree(root, "SYMLINK_SECRET");
  assert.equal(result.matches.length, 0);
});

// ---------------------------------------------------------------------------
// Empty root
// ---------------------------------------------------------------------------

test("returns empty result for an empty directory", async () => {
  const root = tmpDir();
  const result = await searchTree(root, "ANYTHING");
  assert.equal(result.matches.length, 0);
  assert.equal(result.totalMatches, 0);
  assert.equal(result.truncated, false);
  assert.equal(result.available, true);
});
