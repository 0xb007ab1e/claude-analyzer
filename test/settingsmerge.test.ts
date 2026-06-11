/**
 * Unit tests for settingsmerge.ts — deepMerge, diffObjects, flagUnknown.
 *
 * These cover the critical correctness path for settings layering and diffing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { deepMerge, diffObjects, flagUnknown, KNOWN_SETTINGS_KEYS } from "../src/settingsmerge.ts";

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

test("deepMerge: override scalar wins over base scalar", () => {
  const result = deepMerge({ model: "claude-3-5-sonnet" }, { model: "claude-opus-4-5" });
  assert.equal(result["model"], "claude-opus-4-5");
});

test("deepMerge: base keys not in override are preserved", () => {
  const result = deepMerge({ theme: "dark", model: "sonnet" }, { theme: "light" });
  assert.equal(result["theme"], "light");
  assert.equal(result["model"], "sonnet");
});

test("deepMerge: nested objects are merged recursively", () => {
  const base = { permissions: { allow: ["read"], deny: [] } };
  const override = { permissions: { allow: ["read", "write"] } };
  const result = deepMerge(base, override) as { permissions: Record<string, unknown> };
  // allow is overridden (array → replaced)
  assert.deepEqual(result.permissions["allow"], ["read", "write"]);
  // deny is from base (present in base, absent in override)
  assert.deepEqual(result.permissions["deny"], []);
});

test("deepMerge: arrays are replaced whole, not merged", () => {
  const base = { hooks: [{ event: "a" }, { event: "b" }] };
  const override = { hooks: [{ event: "c" }] };
  const result = deepMerge(base, override) as { hooks: unknown[] };
  assert.equal(result.hooks.length, 1);
  assert.deepEqual(result.hooks[0], { event: "c" });
});

test("deepMerge: null value in override wins over object in base", () => {
  const result = deepMerge({ mcpServers: { myServer: {} } }, { mcpServers: null as unknown as Record<string, unknown> });
  assert.equal(result["mcpServers"], null);
});

test("deepMerge: deeply nested merge three levels", () => {
  const base = { env: { NODE_ENV: "development", DEBUG: "true" } };
  const override = { env: { NODE_ENV: "production" } };
  const result = deepMerge(base, override) as { env: Record<string, unknown> };
  assert.equal(result.env["NODE_ENV"], "production");
  assert.equal(result.env["DEBUG"], "true");
});

test("deepMerge: empty override returns copy of base", () => {
  const base = { model: "sonnet", theme: "dark" };
  const result = deepMerge(base, {});
  assert.deepEqual(result, base);
  // Must be a new object, not the same reference.
  assert.notEqual(result, base);
});

test("deepMerge: empty base returns copy of override", () => {
  const override = { model: "opus" };
  const result = deepMerge({}, override);
  assert.deepEqual(result, override);
});

test("deepMerge: override with new key adds it to result", () => {
  const result = deepMerge({ theme: "dark" }, { cleanupPeriodDays: 30 });
  assert.equal(result["theme"], "dark");
  assert.equal(result["cleanupPeriodDays"], 30);
});

// ---------------------------------------------------------------------------
// diffObjects
// ---------------------------------------------------------------------------

test("diffObjects: detects added keys", () => {
  const prev = { theme: "dark" };
  const next = { theme: "dark", model: "opus" };
  const diff = diffObjects(prev, next);
  assert.deepEqual(diff.added, ["model"]);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
});

test("diffObjects: detects removed keys", () => {
  const prev = { theme: "dark", model: "sonnet" };
  const next = { theme: "dark" };
  const diff = diffObjects(prev, next);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, ["model"]);
  assert.deepEqual(diff.changed, []);
});

test("diffObjects: detects changed scalar values", () => {
  const prev = { theme: "dark", model: "sonnet" };
  const next = { theme: "light", model: "sonnet" };
  const diff = diffObjects(prev, next);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0]!.key, "theme");
  assert.equal(diff.changed[0]!.oldValue, "dark");
  assert.equal(diff.changed[0]!.newValue, "light");
});

test("diffObjects: detects changed object values (structural)", () => {
  const prev = { permissions: { allow: ["read"] } };
  const next = { permissions: { allow: ["read", "write"] } };
  const diff = diffObjects(prev, next);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0]!.key, "permissions");
});

test("diffObjects: equal objects produce empty diff", () => {
  const obj = { theme: "dark", model: "sonnet", cleanupPeriodDays: 30 };
  const diff = diffObjects(obj, { ...obj });
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
});

test("diffObjects: both empty produces empty diff", () => {
  const diff = diffObjects({}, {});
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
});

test("diffObjects: handles added + removed + changed in one call", () => {
  const prev = { a: 1, b: 2, c: 3 };
  const next = { a: 99, b: 2, d: 4 };
  const diff = diffObjects(prev, next);
  assert.deepEqual(diff.added, ["d"]);
  assert.deepEqual(diff.removed, ["c"]);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0]!.key, "a");
  assert.equal(diff.changed[0]!.oldValue, 1);
  assert.equal(diff.changed[0]!.newValue, 99);
});

// ---------------------------------------------------------------------------
// flagUnknown
// ---------------------------------------------------------------------------

test("flagUnknown: returns empty array when all keys are known", () => {
  const obj = { model: "sonnet", theme: "dark", permissions: {} };
  const result = flagUnknown(obj, KNOWN_SETTINGS_KEYS);
  assert.deepEqual(result, []);
});

test("flagUnknown: returns unknown keys", () => {
  const obj = { model: "sonnet", myCustomSetting: true, anotherUndocumented: 42 };
  const result = flagUnknown(obj, KNOWN_SETTINGS_KEYS);
  assert.ok(result.includes("myCustomSetting"), "myCustomSetting should be flagged");
  assert.ok(result.includes("anotherUndocumented"), "anotherUndocumented should be flagged");
  assert.ok(!result.includes("model"), "model should NOT be flagged");
});

test("flagUnknown: empty object returns empty array", () => {
  assert.deepEqual(flagUnknown({}, KNOWN_SETTINGS_KEYS), []);
});

test("flagUnknown: works with custom known set", () => {
  const known = new Set(["foo", "bar"]);
  const obj = { foo: 1, bar: 2, baz: 3 };
  const result = flagUnknown(obj, known);
  assert.deepEqual(result, ["baz"]);
});

// ---------------------------------------------------------------------------
// KNOWN_SETTINGS_KEYS sanity
// ---------------------------------------------------------------------------

test("KNOWN_SETTINGS_KEYS contains expected Claude settings keys", () => {
  for (const key of ["model", "theme", "permissions", "hooks", "env", "mcpServers", "includeCoAuthoredBy"]) {
    assert.ok(KNOWN_SETTINGS_KEYS.has(key), `expected '${key}' in KNOWN_SETTINGS_KEYS`);
  }
});
