/**
 * Tests for usage aggregation pure logic.
 *
 * Covers the critical-path pure functions:
 *   bucketByDay, sumUsage, estimateCost, decodeProjectSlug
 *
 * collectUsage (I/O-bound) is verified by the smoke test in the CI script.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketByDay,
  sumUsage,
  estimateCost,
  decodeProjectSlug,
  PRICE_TABLE,
  type TokenTotals,
} from "../src/usage.ts";

// ---------------------------------------------------------------------------
// bucketByDay
// ---------------------------------------------------------------------------

test("bucketByDay: empty array returns empty array", () => {
  assert.deepEqual(bucketByDay([]), []);
});

test("bucketByDay: timestamps on the same UTC day are grouped", () => {
  // Both are 2024-03-15 UTC
  const a = Date.UTC(2024, 2, 15, 8, 0, 0);
  const b = Date.UTC(2024, 2, 15, 23, 59, 0);
  const result = bucketByDay([a, b]);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.date, "2024-03-15");
  assert.equal(result[0]!.count, 2);
});

test("bucketByDay: timestamps on different days produce separate entries", () => {
  const day1 = Date.UTC(2024, 2, 14, 12, 0, 0);
  const day2 = Date.UTC(2024, 2, 15, 12, 0, 0);
  const day3 = Date.UTC(2024, 2, 16, 12, 0, 0);
  const result = bucketByDay([day2, day1, day3, day1]);
  assert.equal(result.length, 3);
  // Sorted ascending
  assert.equal(result[0]!.date, "2024-03-14");
  assert.equal(result[0]!.count, 2);
  assert.equal(result[1]!.date, "2024-03-15");
  assert.equal(result[1]!.count, 1);
  assert.equal(result[2]!.date, "2024-03-16");
  assert.equal(result[2]!.count, 1);
});

test("bucketByDay: result is sorted ascending by date", () => {
  const dates = [
    Date.UTC(2024, 5, 10),
    Date.UTC(2024, 0, 1),
    Date.UTC(2024, 11, 31),
  ];
  const result = bucketByDay(dates);
  for (let i = 1; i < result.length; i++) {
    assert.ok(result[i]!.date > result[i - 1]!.date, "dates should be ascending");
  }
});

// ---------------------------------------------------------------------------
// sumUsage
// ---------------------------------------------------------------------------

test("sumUsage: empty array returns all-zero totals", () => {
  const totals = sumUsage([]);
  assert.deepEqual(totals, { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
});

test("sumUsage: reads usage from record.message.usage (nested form)", () => {
  const records = [
    {
      message: {
        model: "claude-sonnet-4",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        },
      },
    },
  ];
  const totals = sumUsage(records);
  assert.equal(totals.input, 100);
  assert.equal(totals.output, 50);
  assert.equal(totals.cacheCreate, 10);
  assert.equal(totals.cacheRead, 5);
});

test("sumUsage: reads usage from record.usage (direct form)", () => {
  const records = [
    {
      usage: {
        input_tokens: 200,
        output_tokens: 80,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 20,
      },
    },
  ];
  const totals = sumUsage(records);
  assert.equal(totals.input, 200);
  assert.equal(totals.output, 80);
  assert.equal(totals.cacheRead, 20);
});

test("sumUsage: accumulates across multiple records", () => {
  const records = [
    { message: { usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { message: { usage: { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 30, cache_read_input_tokens: 10 } } },
  ];
  const totals = sumUsage(records);
  assert.equal(totals.input, 300);
  assert.equal(totals.output, 150);
  assert.equal(totals.cacheCreate, 30);
  assert.equal(totals.cacheRead, 10);
});

test("sumUsage: skips records with no usage field gracefully", () => {
  const records = [
    { role: "user", content: "hello" },
    { message: { usage: { input_tokens: 50, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    null,
    "not an object",
    42,
  ];
  const totals = sumUsage(records);
  assert.equal(totals.input, 50);
  assert.equal(totals.output, 25);
});

test("sumUsage: treats non-finite / non-number usage values as zero", () => {
  const records = [
    { usage: { input_tokens: "bad", output_tokens: NaN, cache_creation_input_tokens: null, cache_read_input_tokens: undefined } },
  ];
  const totals = sumUsage(records);
  assert.deepEqual(totals, { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
});

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

test("estimateCost: returns undefined when no model matches price table", () => {
  const tokMap = new Map<string, TokenTotals>([
    ["unknown-model-xyz", { input: 1000, output: 500, cacheCreate: 0, cacheRead: 0 }],
  ]);
  assert.equal(estimateCost(tokMap, PRICE_TABLE), undefined);
});

test("estimateCost: returns undefined for empty token map", () => {
  assert.equal(estimateCost(new Map(), PRICE_TABLE), undefined);
});

test("estimateCost: calculates cost for a known model prefix", () => {
  // claude-sonnet-4: $3/MTok input, $15/MTok output, $0.30/MTok cache-read
  const tokMap = new Map<string, TokenTotals>([
    ["claude-sonnet-4-20250514", { input: 1_000_000, output: 1_000_000, cacheCreate: 0, cacheRead: 0 }],
  ]);
  const cost = estimateCost(tokMap, PRICE_TABLE);
  assert.ok(cost !== undefined);
  // 1M input * $3 + 1M output * $15 = $18
  assert.ok(Math.abs(cost - 18) < 0.01, `Expected ~$18 but got ${cost}`);
});

test("estimateCost: includes cache-read at discounted rate", () => {
  // claude-sonnet-4: $0.30/MTok cache-read
  const tokMap = new Map<string, TokenTotals>([
    ["claude-sonnet-4", { input: 0, output: 0, cacheCreate: 0, cacheRead: 1_000_000 }],
  ]);
  const cost = estimateCost(tokMap, PRICE_TABLE);
  assert.ok(cost !== undefined);
  assert.ok(Math.abs(cost - 0.30) < 0.001, `Expected ~$0.30 but got ${cost}`);
});

test("estimateCost: sums across multiple models, skips unrecognised ones", () => {
  const tokMap = new Map<string, TokenTotals>([
    ["claude-haiku-4", { input: 1_000_000, output: 0, cacheCreate: 0, cacheRead: 0 }],
    ["totally-unknown-model", { input: 9_999_999, output: 9_999_999, cacheCreate: 0, cacheRead: 0 }],
  ]);
  const cost = estimateCost(tokMap, PRICE_TABLE);
  assert.ok(cost !== undefined);
  // claude-haiku-4: 1M input * $0.80 = $0.80; unknown model contributes nothing
  assert.ok(Math.abs(cost - 0.80) < 0.001, `Expected ~$0.80 but got ${cost}`);
});

test("estimateCost: cache-creation tokens billed at input rate", () => {
  // claude-sonnet-4: $3/MTok input rate applies to cache-creation
  const tokMap = new Map<string, TokenTotals>([
    ["claude-sonnet-4", { input: 0, output: 0, cacheCreate: 1_000_000, cacheRead: 0 }],
  ]);
  const cost = estimateCost(tokMap, PRICE_TABLE);
  assert.ok(cost !== undefined);
  assert.ok(Math.abs(cost - 3.00) < 0.001, `Expected ~$3.00 but got ${cost}`);
});

// ---------------------------------------------------------------------------
// decodeProjectSlug
// ---------------------------------------------------------------------------

test("decodeProjectSlug: decodes a typical Claude project slug", () => {
  assert.equal(decodeProjectSlug("-home-alice-myproject"), "/home/alice/myproject");
});

test("decodeProjectSlug: handles slug with no leading dash", () => {
  // Edge-case: some slugs may not start with a dash
  const result = decodeProjectSlug("home-bob-work");
  assert.equal(result, "/home/bob/work");
});

test("decodeProjectSlug: returns root slash for empty string", () => {
  assert.equal(decodeProjectSlug(""), "/");
});

test("decodeProjectSlug: handles deeply nested paths", () => {
  const slug = "-home-user-projects-ai-claude-test";
  assert.equal(decodeProjectSlug(slug), "/home/user/projects/ai/claude/test");
});
