/**
 * Tests for the quick-open fuzzy matcher: subsequence match/no-match, the
 * basename + boundary + contiguity preferences, and ranking/limit behaviour.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyScore, fuzzyRank } from "../src/fuzzy.ts";

test("fuzzyScore matches in-order subsequences, rejects others", () => {
  assert.ok(fuzzyScore("stjson", "settings.json") >= 0);
  assert.ok(fuzzyScore("set", "settings.json") >= 0);
  assert.equal(fuzzyScore("zzz", "settings.json"), -1);
  // Out-of-order characters don't match.
  assert.equal(fuzzyScore("nosj", "settings.json"), -1);
  assert.equal(fuzzyScore("", "anything"), 0);
});

test("fuzzyScore is case-insensitive", () => {
  assert.ok(fuzzyScore("CLAUDE", "agents/claude.md") >= 0);
});

test("contiguous + boundary + basename matches score higher", () => {
  // Contiguous run beats scattered hits.
  assert.ok(fuzzyScore("set", "settings.json") > fuzzyScore("set", "s/e/t/x.json"));
  // A basename hit beats the same letters only in a directory.
  assert.ok(
    fuzzyScore("readme", "docs/README.md") > fuzzyScore("readme", "readme-assets/x.bin"),
  );
});

test("fuzzyRank orders by score and respects the limit", () => {
  const paths = [
    "projects/a/settings.json",
    "settings.json",
    "notes/setup.txt",
    "unrelated/file.bin",
  ];
  const ranked = fuzzyRank("settings", paths, 10);
  assert.equal(ranked[0], "settings.json"); // best (boundary + basename, short)
  assert.ok(ranked.includes("projects/a/settings.json"));
  assert.ok(!ranked.includes("unrelated/file.bin")); // no subsequence match
  assert.ok(ranked.length <= 10);
});

test("fuzzyRank with an empty query returns the head of the list", () => {
  const paths = ["a", "b", "c", "d"];
  assert.deepEqual(fuzzyRank("", paths, 2), ["a", "b"]);
});
