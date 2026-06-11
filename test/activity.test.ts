/**
 * Unit tests for src/activity.ts — deterministic bucketing and summary logic.
 *
 * All tests pass an explicit `nowMs` so there is no dependency on the real
 * wall clock. The filesystem-walk function {@link collectMtimes} is tested
 * separately via a real temp directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bucketByDay,
  bucketByHour,
  summarize,
  collectMtimes,
  msToDateLabel,
  floorToDay,
  endOfDay,
} from "../src/activity.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixed "now" for all tests: 2024-03-15 12:00:00 UTC. */
const NOW = Date.UTC(2024, 2, 15, 12, 0, 0); // March 15 2024 noon UTC

/** Make an epoch-ms timestamp at a given UTC date/hour. */
function at(year: number, month: number, day: number, hour = 0): number {
  return Date.UTC(year, month - 1, day, hour, 0, 0);
}

// ---------------------------------------------------------------------------
// msToDateLabel
// ---------------------------------------------------------------------------

test("msToDateLabel formats YYYY-MM-DD in UTC", () => {
  assert.equal(msToDateLabel(at(2024, 3, 15, 11)), "2024-03-15");
  assert.equal(msToDateLabel(at(2024, 1, 1, 0)), "2024-01-01");
  assert.equal(msToDateLabel(at(2024, 12, 31, 23)), "2024-12-31");
});

test("msToDateLabel pads month and day to 2 digits", () => {
  assert.equal(msToDateLabel(at(2024, 2, 5, 0)), "2024-02-05");
});

// ---------------------------------------------------------------------------
// floorToDay / endOfDay
// ---------------------------------------------------------------------------

test("floorToDay truncates to 00:00:00.000 UTC", () => {
  const noon = at(2024, 3, 15, 12);
  const start = floorToDay(noon);
  assert.equal(msToDateLabel(start), "2024-03-15");
  assert.equal(start % 86_400_000, 0);
});

test("endOfDay returns last ms of the UTC day", () => {
  const noon = at(2024, 3, 15, 12);
  const end = endOfDay(noon);
  assert.equal(msToDateLabel(end), "2024-03-15");
  // The next millisecond is the next day.
  assert.equal(msToDateLabel(end + 1), "2024-03-16");
});

// ---------------------------------------------------------------------------
// bucketByDay
// ---------------------------------------------------------------------------

test("bucketByDay produces one entry per calendar day in window", () => {
  const from = floorToDay(at(2024, 3, 13));
  const to = endOfDay(at(2024, 3, 15));
  const result = bucketByDay([], from, to);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((b) => b.date), ["2024-03-13", "2024-03-14", "2024-03-15"]);
  assert.deepEqual(result.map((b) => b.count), [0, 0, 0]);
});

test("bucketByDay counts mtimes into correct day buckets", () => {
  const from = floorToDay(at(2024, 3, 13));
  const to = endOfDay(at(2024, 3, 15));
  const mtimes = [
    at(2024, 3, 13, 8),
    at(2024, 3, 13, 22),
    at(2024, 3, 14, 0),
    at(2024, 3, 15, 23),
    at(2024, 3, 15, 23),
  ];
  const result = bucketByDay(mtimes, from, to);
  assert.equal(result[0]!.count, 2); // March 13
  assert.equal(result[1]!.count, 1); // March 14
  assert.equal(result[2]!.count, 2); // March 15
});

test("bucketByDay ignores mtimes outside the window", () => {
  const from = floorToDay(at(2024, 3, 14));
  const to = endOfDay(at(2024, 3, 14));
  const mtimes = [
    at(2024, 3, 13, 23, ), // day before — excluded
    at(2024, 3, 14, 5),    // in window
    at(2024, 3, 15, 1),    // day after — excluded
  ];
  const result = bucketByDay(mtimes, from, to);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.count, 1);
});

test("bucketByDay handles empty mtime array (all zeros)", () => {
  const from = floorToDay(at(2024, 3, 1));
  const to = endOfDay(at(2024, 3, 7));
  const result = bucketByDay([], from, to);
  assert.equal(result.length, 7);
  assert.ok(result.every((b) => b.count === 0));
});

test("bucketByDay handles single-day window", () => {
  const from = floorToDay(at(2024, 3, 15));
  const to = endOfDay(at(2024, 3, 15));
  const result = bucketByDay([at(2024, 3, 15, 6), at(2024, 3, 15, 20)], from, to);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.count, 2);
});

// ---------------------------------------------------------------------------
// bucketByHour
// ---------------------------------------------------------------------------

test("bucketByHour returns a 24-element array", () => {
  const from = floorToDay(at(2024, 3, 1));
  const to = endOfDay(at(2024, 3, 7));
  const h = bucketByHour([], from, to);
  assert.equal(h.length, 24);
  assert.ok(h.every((v) => v === 0));
});

test("bucketByHour counts each UTC hour bucket", () => {
  const from = floorToDay(at(2024, 3, 1));
  const to = endOfDay(at(2024, 3, 7));
  const mtimes = [
    at(2024, 3, 1, 0),
    at(2024, 3, 2, 0),
    at(2024, 3, 3, 14),
    at(2024, 3, 4, 23),
  ];
  const h = bucketByHour(mtimes, from, to);
  assert.equal(h[0], 2);  // midnight hit twice
  assert.equal(h[14], 1);
  assert.equal(h[23], 1);
  assert.equal(h.reduce((s, v) => s + v, 0), 4);
});

test("bucketByHour ignores times outside window", () => {
  const from = floorToDay(at(2024, 3, 5));
  const to = endOfDay(at(2024, 3, 5));
  // Only the March 5 entry is inside the window.
  const mtimes = [at(2024, 3, 4, 10), at(2024, 3, 5, 10), at(2024, 3, 6, 10)];
  const h = bucketByHour(mtimes, from, to);
  assert.equal(h[10], 1);
  assert.equal(h.reduce((s, v) => s + v, 0), 1);
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

test("summarize produces correct number of day buckets for requested window", () => {
  const result = summarize([], 7, NOW, false);
  assert.equal(result.days.length, 7);
});

test("summarize produces 90-day window by default shape", () => {
  const result = summarize([], 90, NOW, false);
  assert.equal(result.days.length, 90);
  assert.equal(result.byHour.length, 24);
});

test("summarize clamps days to 1-365", () => {
  assert.equal(summarize([], 0, NOW, false).days.length, 1);
  assert.equal(summarize([], 400, NOW, false).days.length, 365);
});

test("summarize reports correct total", () => {
  // 3 mtimes all in the 7-day window.
  const mtimes = [
    at(2024, 3, 15, 1),
    at(2024, 3, 14, 2),
    at(2024, 3, 10, 3),
  ];
  const result = summarize(mtimes, 7, NOW, false);
  assert.equal(result.total, 3);
});

test("summarize excludes mtimes outside the window from total", () => {
  const mtimes = [
    at(2024, 3, 15, 1),   // in 7-day window
    at(2024, 2, 1, 0),    // way outside window
  ];
  const result = summarize(mtimes, 7, NOW, false);
  assert.equal(result.total, 1);
});

test("summarize identifies busiestDay", () => {
  const mtimes = [
    at(2024, 3, 13, 1),
    at(2024, 3, 13, 2),
    at(2024, 3, 13, 3),
    at(2024, 3, 14, 5),
  ];
  const result = summarize(mtimes, 7, NOW, false);
  assert.ok(result.busiestDay !== null);
  assert.equal(result.busiestDay!.date, "2024-03-13");
  assert.equal(result.busiestDay!.count, 3);
});

test("summarize identifies busiestHour", () => {
  const mtimes = [
    at(2024, 3, 15, 9),
    at(2024, 3, 14, 9),
    at(2024, 3, 13, 9),
    at(2024, 3, 13, 22),
  ];
  const result = summarize(mtimes, 7, NOW, false);
  assert.ok(result.busiestHour !== null);
  assert.equal(result.busiestHour!.hour, 9);
  assert.equal(result.busiestHour!.count, 3);
});

test("summarize returns null busiestDay and busiestHour when no data in window", () => {
  const result = summarize([], 7, NOW, false);
  assert.equal(result.busiestDay, null);
  assert.equal(result.busiestHour, null);
});

test("summarize propagates truncated flag", () => {
  const r1 = summarize([], 7, NOW, false);
  const r2 = summarize([], 7, NOW, true);
  assert.equal(r1.truncated, false);
  assert.equal(r2.truncated, true);
});

test("summarize range.fromMs is start of window day, range.toMs is end of today", () => {
  const result = summarize([], 7, NOW, false);
  // toMs should be end of the day containing NOW.
  assert.equal(msToDateLabel(result.range.toMs), "2024-03-15");
  // fromMs should be 7 days back (March 9 — 7-day window means today + 6 prior days).
  assert.equal(msToDateLabel(result.range.fromMs), "2024-03-09");
});

// ---------------------------------------------------------------------------
// collectMtimes (filesystem walk)
// ---------------------------------------------------------------------------

/** Create a temp directory tree with specific mtimes for testing the walk. */
function makeTree(): { root: string; expectedMtimes: number[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "analyzer-activity-test-")));
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  mkdirSync(join(root, ".analyzer-backups"), { recursive: true });

  const t1 = Math.floor(Date.UTC(2024, 2, 10, 8) / 1000);  // seconds for utimes
  const t2 = Math.floor(Date.UTC(2024, 2, 14, 20) / 1000);

  writeFileSync(join(root, "a.json"), "{}");
  utimesSync(join(root, "a.json"), t1, t1);

  writeFileSync(join(root, "sub", "b.txt"), "hello");
  utimesSync(join(root, "sub", "b.txt"), t2, t2);

  // These should be skipped (in excluded dirs).
  writeFileSync(join(root, ".git", "HEAD"), "ref: ...");
  writeFileSync(join(root, "node_modules", "x.js"), "module");
  writeFileSync(join(root, ".analyzer-backups", "bak"), "bak");

  return {
    root,
    expectedMtimes: [t1 * 1000, t2 * 1000],
  };
}

test("collectMtimes collects mtimes from regular files only", async () => {
  const { root, expectedMtimes } = makeTree();
  const { mtimesMs, truncated } = await collectMtimes(root);
  assert.equal(truncated, false);
  // Should have exactly 2 files (a.json and sub/b.txt).
  assert.equal(mtimesMs.length, 2);
  // The actual ms values may have up to 1-second OS-precision rounding; just
  // verify they are within 1s of the expected values.
  const sorted = [...mtimesMs].sort((a, b) => a - b);
  const exp = [...expectedMtimes].sort((a, b) => a - b);
  for (let i = 0; i < exp.length; i++) {
    assert.ok(Math.abs(sorted[i]! - exp[i]!) <= 1000,
      `mtime[${i}] expected ~${exp[i]} got ${sorted[i]}`);
  }
});

test("collectMtimes excludes .git, node_modules, .analyzer-backups", async () => {
  const { root } = makeTree();
  const { mtimesMs } = await collectMtimes(root);
  // Only 2 real files; the 3 excluded dirs contribute 0 files.
  assert.equal(mtimesMs.length, 2);
});
