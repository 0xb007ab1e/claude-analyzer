/**
 * Tests for binary classification, raw content-types, and the chunked
 * line-window reader used by the large-file loader.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewerKind, contentType, readFileLines, MAX_LINES_PER_REQUEST } from "../src/files.ts";

function tmpRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "ca-files-")));
}

test("viewerKind classifies images, pdf, and other binaries", () => {
  for (const e of ["jpg", "jpeg", "png", "gif", "webp", "ico", "svg", "bmp", "avif"]) {
    assert.equal(viewerKind(e), "image", e);
  }
  assert.equal(viewerKind("pdf"), "pdf");
  for (const e of ["db", "sqlite", "bin", "gz", "zip", "wasm", "pyc", ""]) {
    assert.equal(viewerKind(e), "download", e);
  }
});

test("contentType maps known types and falls back to octet-stream", () => {
  assert.equal(contentType("jpg"), "image/jpeg");
  assert.equal(contentType("png"), "image/png");
  assert.equal(contentType("svg"), "image/svg+xml");
  assert.equal(contentType("pdf"), "application/pdf");
  assert.equal(contentType("db"), "application/octet-stream");
  assert.equal(contentType(""), "application/octet-stream");
});

test("readFileLines returns a window with total + hasMore", async () => {
  const root = tmpRoot();
  const body = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  writeFileSync(join(root, "big.txt"), body);
  const page = await readFileLines(root, "big.txt", 10, 5, false);
  assert.equal(page.total, 50);
  assert.equal(page.from, 10);
  assert.deepEqual(page.lines.map((l) => l.n), [10, 11, 12, 13, 14]);
  assert.equal(page.lines[0]?.text, "line 10");
  assert.equal(page.hasMore, true);
});

test("readFileLines last window sets hasMore false", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "f.txt"), "a\nb\nc");
  const page = await readFileLines(root, "f.txt", 2, 100, false);
  assert.equal(page.total, 3);
  assert.deepEqual(page.lines.map((l) => l.text), ["c"]);
  assert.equal(page.hasMore, false);
});

test("readFileLines redacts per line unless reveal", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "s.jsonl"), '{"token":"sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA"}\n{"x":1}\n');
  const redacted = await readFileLines(root, "s.jsonl", 0, 10, false);
  assert.equal(redacted.redacted, true);
  assert.doesNotMatch(redacted.lines[0]?.text ?? "", /AAAAAAAA/);
  const raw = await readFileLines(root, "s.jsonl", 0, 10, true);
  assert.equal(raw.redacted, false);
  assert.match(raw.lines[0]?.text ?? "", /sk-ant-/);
});

test("readFileLines clamps count to the per-request cap", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "f.txt"), "x");
  const page = await readFileLines(root, "f.txt", 0, MAX_LINES_PER_REQUEST + 5000, false);
  assert.ok(page.lines.length <= MAX_LINES_PER_REQUEST);
});
