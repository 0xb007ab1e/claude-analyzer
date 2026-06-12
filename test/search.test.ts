/**
 * Tests for full-text search: case-insensitive matching, line numbers +
 * snippets, secret redaction in snippets (no leakage), text-only/skip-dir
 * filtering, short-query rejection, and result ordering.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchTreeText, SearchError, MIN_QUERY_LENGTH } from "../src/search.ts";

function tmpRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "ca-search-")));
}

test("rejects queries shorter than the minimum", async () => {
  const root = tmpRoot();
  await assert.rejects(() => searchTreeText(root, "a"), SearchError);
  await assert.rejects(() => searchTreeText(root, " "), SearchError);
  assert.ok(MIN_QUERY_LENGTH >= 2);
});

test("matches case-insensitively with line numbers and snippets", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "a.md"), "First line\nThe Anthropic API\nlast\n");
  writeFileSync(join(root, "b.txt"), "nothing here\n");
  const r = await searchTreeText(root, "anthropic");
  assert.equal(r.matchedFiles, 1);
  const file = r.files[0];
  assert.equal(file?.path, "a.md");
  assert.equal(file?.total, 1);
  assert.equal(file?.hits[0]?.line, 2);
  assert.match(file?.hits[0]?.snippet ?? "", /Anthropic API/);
});

test("snippets are redacted — a matched secret never leaks", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "conf.txt"), 'api_key: sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA\n');
  const r = await searchTreeText(root, "api_key");
  const snippet = r.files[0]?.hits[0]?.snippet ?? "";
  assert.doesNotMatch(snippet, /AAAAAAAA/, "raw secret must not appear in the snippet");
  assert.equal(r.files[0]?.redacted, true);
});

test("whole-file-sensitive paths are fully masked in snippets", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, ".credentials.json"), '{"apiKey":"super-secret-value-123"}\n');
  const r = await searchTreeText(root, "apikey");
  const snippet = r.files[0]?.hits[0]?.snippet ?? "";
  assert.doesNotMatch(snippet, /super-secret-value/);
  assert.equal(r.files[0]?.redacted, true);
});

test("only text files are searched; binaries are skipped", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "note.txt"), "find the needle\n");
  writeFileSync(join(root, "image.png"), "needle hidden in a pretend png\n");
  const r = await searchTreeText(root, "needle");
  assert.deepEqual(r.files.map((f) => f.path), ["note.txt"]);
});

test("skips .git and backup directories", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config.txt"), "needle in git\n");
  mkdirSync(join(root, ".analyzer-backups"));
  writeFileSync(join(root, ".analyzer-backups", "old.txt"), "needle in backup\n");
  writeFileSync(join(root, "real.txt"), "needle in real\n");
  const r = await searchTreeText(root, "needle");
  assert.deepEqual(r.files.map((f) => f.path), ["real.txt"]);
});

test("results are ordered by total matches descending", async () => {
  const root = tmpRoot();
  writeFileSync(join(root, "few.txt"), "x token\n");
  writeFileSync(join(root, "many.txt"), "token\ntoken\ntoken\n");
  const r = await searchTreeText(root, "token");
  assert.deepEqual(r.files.map((f) => f.path), ["many.txt", "few.txt"]);
  assert.equal(r.totalMatches, 4);
  assert.equal(r.scanned, 2);
});

test("long matching lines are windowed with ellipsis", async () => {
  const root = tmpRoot();
  const long = "x".repeat(300) + " NEEDLE " + "y".repeat(300);
  writeFileSync(join(root, "long.txt"), long + "\n");
  const r = await searchTreeText(root, "needle");
  const snippet = r.files[0]?.hits[0]?.snippet ?? "";
  assert.ok(snippet.startsWith("…") && snippet.endsWith("…"), `windowed: ${snippet.slice(0, 20)}`);
  assert.ok(snippet.length < long.length);
});
