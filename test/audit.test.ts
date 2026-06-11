/**
 * Tests for the audit pure-logic helpers in src/audit.ts.
 *
 * These cover the functions that must remain correct to avoid either leaking
 * raw secret values (countMaskHits, firstMaskedSnippet) or producing wrong
 * advisory output (classifyStale, summarizeSizes, isGroupOrWorldReadable).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countMaskHits,
  firstMaskedSnippet,
  isGroupOrWorldReadable,
  modeToOctal,
  summarizeSizes,
  classifyStale,
  REDACT_MASK,
} from "../src/audit.ts";

// ---------------------------------------------------------------------------
// countMaskHits
// ---------------------------------------------------------------------------

test("countMaskHits: zero when no mask present", () => {
  assert.equal(countMaskHits("no secrets here"), 0);
});

test("countMaskHits: counts single occurrence", () => {
  assert.equal(countMaskHits(`token: ${REDACT_MASK}`), 1);
});

test("countMaskHits: counts multiple occurrences on separate lines", () => {
  const text = [
    `access_token: ${REDACT_MASK}`,
    `refresh_token: ${REDACT_MASK}`,
    `name: alice`,
  ].join("\n");
  assert.equal(countMaskHits(text), 2);
});

test("countMaskHits: counts adjacent occurrences without overlap", () => {
  // Two masks with no separator between them.
  const text = REDACT_MASK + REDACT_MASK;
  assert.equal(countMaskHits(text), 2);
});

test("countMaskHits: returns 0 for empty string", () => {
  assert.equal(countMaskHits(""), 0);
});

test("countMaskHits: custom mask string", () => {
  assert.equal(countMaskHits("XXXX foo XXXX", "XXXX"), 2);
});

// ---------------------------------------------------------------------------
// firstMaskedSnippet
// ---------------------------------------------------------------------------

test("firstMaskedSnippet: returns empty when no mask present", () => {
  assert.equal(firstMaskedSnippet("clean content, no secrets"), "");
});

test("firstMaskedSnippet: returns the first masked line (trimmed)", () => {
  const text = [
    "theme: dark",
    `  secret: ${REDACT_MASK}  `,
    `  other: ${REDACT_MASK}`,
  ].join("\n");
  const snippet = firstMaskedSnippet(text);
  assert.match(snippet, new RegExp(REDACT_MASK.replace(/«/g, "\\«").replace(/»/g, "\\»")));
  // Must be the first masked line, trimmed.
  assert.equal(snippet, `secret: ${REDACT_MASK}`);
});

test("firstMaskedSnippet: truncates long lines to 200 chars", () => {
  const longLine = "a".repeat(100) + REDACT_MASK + "b".repeat(200);
  const snippet = firstMaskedSnippet(longLine);
  assert.ok(snippet.length <= 200, `snippet length ${snippet.length} > 200`);
});

test("firstMaskedSnippet: never returns raw secret (only masked text)", () => {
  // Simulate redacted output — no raw value should appear.
  const redacted = `api_key: ${REDACT_MASK}`;
  const snippet = firstMaskedSnippet(redacted);
  // The snippet must contain the mask, not any raw credential text.
  assert.match(snippet, new RegExp(REDACT_MASK.replace(/«/g, "\\«").replace(/»/g, "\\»")));
  // No raw secret in output — the mask is the only non-structural text.
  assert.doesNotMatch(snippet, /sk-[A-Za-z0-9]{10,}/);
});

// ---------------------------------------------------------------------------
// isGroupOrWorldReadable
// ---------------------------------------------------------------------------

test("isGroupOrWorldReadable: 0o600 is NOT group/world readable", () => {
  // -rw------- : owner read/write only
  assert.equal(isGroupOrWorldReadable(0o100600), false);
});

test("isGroupOrWorldReadable: 0o644 IS group/world readable (group read)", () => {
  // -rw-r--r-- : owner rw, group r, world r
  assert.equal(isGroupOrWorldReadable(0o100644), true);
});

test("isGroupOrWorldReadable: 0o640 IS group readable", () => {
  // -rw-r----- : owner rw, group r
  assert.equal(isGroupOrWorldReadable(0o100640), true);
});

test("isGroupOrWorldReadable: 0o700 is NOT group/world readable", () => {
  // -rwx------ : owner execute only; no group/world bits
  assert.equal(isGroupOrWorldReadable(0o100700), false);
});

test("isGroupOrWorldReadable: 0o777 IS group/world readable", () => {
  assert.equal(isGroupOrWorldReadable(0o100777), true);
});

// ---------------------------------------------------------------------------
// modeToOctal
// ---------------------------------------------------------------------------

test("modeToOctal: standard file modes format correctly", () => {
  assert.equal(modeToOctal(0o100644), "0644");
  assert.equal(modeToOctal(0o100600), "0600");
  assert.equal(modeToOctal(0o100755), "0755");
  assert.equal(modeToOctal(0o100777), "0777");
});

test("modeToOctal: strips high file-type bits", () => {
  // Directory mode 0o40755 → permission part is 0755.
  assert.equal(modeToOctal(0o40755), "0755");
});

// ---------------------------------------------------------------------------
// summarizeSizes
// ---------------------------------------------------------------------------

test("summarizeSizes: empty map returns empty array", () => {
  assert.deepEqual(summarizeSizes(new Map()), []);
});

test("summarizeSizes: groups files under top-level dirs", () => {
  const entries = new Map([
    ["projects/foo/a.json", 100],
    ["projects/foo/b.json", 200],
    ["settings.json", 50],
    ["sessions/x.jsonl", 400],
  ]);
  const result = summarizeSizes(entries);
  // Should have three buckets: "projects", "", "sessions"
  const byDir = Object.fromEntries(result.map((r) => [r.dir, r.bytes]));
  assert.equal(byDir["projects"], 300);
  assert.equal(byDir[""], 50);
  assert.equal(byDir["sessions"], 400);
});

test("summarizeSizes: sorted descending by bytes", () => {
  const entries = new Map([
    ["a/x", 10],
    ["b/y", 500],
    ["c/z", 200],
  ]);
  const result = summarizeSizes(entries);
  assert.equal(result[0]!.dir, "b");
  assert.equal(result[1]!.dir, "c");
  assert.equal(result[2]!.dir, "a");
});

test("summarizeSizes: root-level files grouped under empty-string dir", () => {
  const entries = new Map([["toplevel.json", 999]]);
  const result = summarizeSizes(entries);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.dir, "");
  assert.equal(result[0]!.bytes, 999);
});

// ---------------------------------------------------------------------------
// classifyStale
// ---------------------------------------------------------------------------

test("classifyStale: recent file in a normal path is not stale", () => {
  assert.equal(classifyStale("projects/foo/bar.json", 5), null);
});

test("classifyStale: file older than 90 days is stale", () => {
  const suggestion = classifyStale("settings.json", 91);
  assert.ok(suggestion !== null, "expected a suggestion for old file");
  assert.match(suggestion!, /91\s*days/);
});

test("classifyStale: exactly 90 days is stale", () => {
  const suggestion = classifyStale("random.txt", 90);
  assert.ok(suggestion !== null, "expected a suggestion at exactly 90 days");
});

test("classifyStale: .analyzer-backups/ is always stale", () => {
  const s = classifyStale(".analyzer-backups/settings.json.2024-01-01.bak", 1);
  assert.ok(s !== null);
  assert.match(s!, /[Bb]ackup/);
});

test("classifyStale: paste-cache/ is always stale", () => {
  const s = classifyStale("paste-cache/abc123.txt", 0);
  assert.ok(s !== null);
  assert.match(s!, /[Pp]aste/);
});

test("classifyStale: shell-snapshots/ is always stale", () => {
  const s = classifyStale("shell-snapshots/snap001.sh", 2);
  assert.ok(s !== null);
  assert.match(s!, /[Ss]napshot/);
});

test("classifyStale: .bak extension is always stale", () => {
  const s = classifyStale("config.bak", 3);
  assert.ok(s !== null);
  assert.match(s!, /[Bb]ackup/);
});

test("classifyStale: log files are always stale", () => {
  const s = classifyStale("debug.log", 2);
  assert.ok(s !== null);
  assert.match(s!, /[Ll]og/);
});

test("classifyStale: backups/ directory path is always stale", () => {
  const s = classifyStale("backups/old.json", 0);
  assert.ok(s !== null);
});
