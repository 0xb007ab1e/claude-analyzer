/**
 * Unit tests for the LCS-based line differ (src/diff.ts).
 *
 * Run via:
 *   node --experimental-strip-types --test 'test/**\/*.test.ts'
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, type DiffLine } from "../src/diff.ts";

// Helper to pull only the type+text from a diff result for terse assertions.
function slim(lines: DiffLine[]): Array<[string, string]> {
  return lines.map((l) => [l.type, l.text]);
}

test("identical strings → empty diff (context-only = no changes)", () => {
  const result = diffLines("hello\nworld\n", "hello\nworld\n");
  assert.equal(result.length, 0, "no diff lines expected for identical input");
});

test("identical empty strings → empty diff", () => {
  const result = diffLines("", "");
  assert.equal(result.length, 0);
});

test("pure addition (empty → content)", () => {
  const result = diffLines("", "line1\nline2\n");
  const types = result.map((l) => l.type);
  assert.ok(types.every((t) => t === "add"), "all lines should be additions");
  assert.equal(result[0]?.text, "line1");
  assert.equal(result[1]?.text, "line2");
});

test("pure deletion (content → empty)", () => {
  const result = diffLines("line1\nline2\n", "");
  const types = result.map((l) => l.type);
  assert.ok(types.every((t) => t === "del"), "all lines should be deletions");
  assert.equal(result[0]?.text, "line1");
  assert.equal(result[1]?.text, "line2");
});

test("single-line substitution", () => {
  const result = diffLines("hello\nworld\n", "hello\nearth\n");
  const s = slim(result);
  // "hello" is context (within 3 lines of change), "world" del, "earth" add
  assert.deepEqual(s, [
    ["ctx", "hello"],
    ["del", "world"],
    ["add", "earth"],
  ]);
});

test("line numbers are 1-based and correct", () => {
  const result = diffLines("a\nb\nc\n", "a\nB\nc\n");
  const ctx = result.filter((l) => l.type === "ctx");
  const del = result.find((l) => l.type === "del");
  const add = result.find((l) => l.type === "add");

  // "a" should be ctx with aLine=1, bLine=1
  assert.ok(ctx.some((l) => l.aLine === 1 && l.bLine === 1));
  // "b" deleted → aLine=2
  assert.equal(del?.aLine, 2);
  assert.equal(del?.bLine, undefined);
  // "B" added → bLine=2
  assert.equal(add?.bLine, 2);
  assert.equal(add?.aLine, undefined);
});

test("context lines: change in the middle is surrounded by ctx", () => {
  const a = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
  const b = "1\n2\n3\n4\nX\n6\n7\n8\n9\n10\n";
  const result = diffLines(a, b);
  // Line 5 changes; expect 3 context lines on each side
  const del = result.find((l) => l.type === "del" && l.text === "5");
  const add = result.find((l) => l.type === "add" && l.text === "X");
  assert.ok(del, "deletion of '5' present");
  assert.ok(add, "addition of 'X' present");
  // Lines 2..4 and 6..8 should appear as ctx
  const ctxTexts = result.filter((l) => l.type === "ctx").map((l) => l.text);
  assert.ok(ctxTexts.includes("2"), "line 2 present as context");
  assert.ok(ctxTexts.includes("8"), "line 8 present as context");
  // Lines 1 and 9 are out of range (>3 away) — should NOT appear
  assert.ok(!ctxTexts.includes("1"), "line 1 beyond ctx window");
  assert.ok(!ctxTexts.includes("10"), "line 10 beyond ctx window");
});

test("multiple disjoint changes produce separate context windows", () => {
  const a = Array.from({ length: 20 }, (_, i) => String(i + 1)).join("\n") + "\n";
  const b = a.replace(/^5$/m, "FIVE").replace(/^15$/m, "FIFTEEN");
  const result = diffLines(a, b);
  const dels = result.filter((l) => l.type === "del").map((l) => l.text);
  const adds = result.filter((l) => l.type === "add").map((l) => l.text);
  assert.ok(dels.includes("5"));
  assert.ok(adds.includes("FIVE"));
  assert.ok(dels.includes("15"));
  assert.ok(adds.includes("FIFTEEN"));
});

test("content without trailing newline is handled", () => {
  const result = diffLines("foo\nbar", "foo\nbaz");
  const del = result.find((l) => l.type === "del");
  const add = result.find((l) => l.type === "add");
  assert.equal(del?.text, "bar");
  assert.equal(add?.text, "baz");
});

test("unicode content is preserved verbatim", () => {
  const a = "line1\nこんにちは\nline3\n";
  const b = "line1\n世界\nline3\n";
  const result = diffLines(a, b);
  const del = result.find((l) => l.type === "del");
  const add = result.find((l) => l.type === "add");
  assert.equal(del?.text, "こんにちは");
  assert.equal(add?.text, "世界");
});

test("a vs empty is all deletions", () => {
  const result = diffLines("x\ny\nz\n", "");
  assert.ok(result.every((l) => l.type === "del"));
});

test("empty vs b is all additions", () => {
  const result = diffLines("", "x\ny\nz\n");
  assert.ok(result.every((l) => l.type === "add"));
});

test("custom contextLines=0 suppresses context", () => {
  const result = diffLines("a\nb\nc\n", "a\nX\nc\n", 0);
  // With 0 context, only the changed lines should appear
  assert.ok(!result.some((l) => l.type === "ctx"), "no ctx lines when contextLines=0");
  assert.ok(result.some((l) => l.type === "del" && l.text === "b"));
  assert.ok(result.some((l) => l.type === "add" && l.text === "X"));
});

test("custom contextLines=1 shows 1 surrounding line", () => {
  const a = "1\n2\n3\n4\n5\n";
  const b = "1\n2\n3\n4\nX\n";
  const result = diffLines(a, b, 1);
  const ctxTexts = result.filter((l) => l.type === "ctx").map((l) => l.text);
  // Only "4" (1 line before change) should appear as ctx; "3" is 2 away
  assert.ok(ctxTexts.includes("4"), "line immediately before change is ctx");
  assert.ok(!ctxTexts.includes("3"), "line 2 away is not ctx at window 1");
});
