/**
 * Tests for session-transcript helpers.
 *
 * These cover isSessionPath, sessionUuid, decodeProjectCwd, and sessionInfo —
 * all pure functions with no I/O. The session path format is load-bearing for
 * the transcript viewer feature, so keep coverage at 100%.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSessionPath,
  sessionUuid,
  decodeProjectCwd,
  sessionInfo,
  extractSessionCwd,
} from "../src/sessions.ts";

// ---------------------------------------------------------------------------
// isSessionPath
// ---------------------------------------------------------------------------

test("isSessionPath: accepts a canonical session path", () => {
  assert.equal(
    isSessionPath("projects/-home-alice-project/550e8400-e29b-41d4-a716-446655440000.jsonl"),
    true,
  );
});

test("isSessionPath: accepts uppercase UUID letters", () => {
  assert.equal(
    isSessionPath("projects/-home-user/550E8400-E29B-41D4-A716-446655440000.jsonl"),
    true,
  );
});

test("isSessionPath: rejects a plain .jsonl at the root", () => {
  assert.equal(isSessionPath("session.jsonl"), false);
});

test("isSessionPath: rejects a .jsonl directly under projects/", () => {
  assert.equal(
    isSessionPath("projects/550e8400-e29b-41d4-a716-446655440000.jsonl"),
    false,
  );
});

test("isSessionPath: rejects a non-UUID filename", () => {
  assert.equal(
    isSessionPath("projects/-home-user/not-a-uuid.jsonl"),
    false,
  );
});

test("isSessionPath: rejects a too-short UUID segment", () => {
  assert.equal(
    isSessionPath("projects/-home-user/550e8400-e29b-41d4-a716.jsonl"),
    false,
  );
});

test("isSessionPath: rejects a .json (not .jsonl) file", () => {
  assert.equal(
    isSessionPath("projects/-home-user/550e8400-e29b-41d4-a716-446655440000.json"),
    false,
  );
});

test("isSessionPath: rejects a nested path with extra segments", () => {
  assert.equal(
    isSessionPath("projects/-home-user/subdir/550e8400-e29b-41d4-a716-446655440000.jsonl"),
    false,
  );
});

test("isSessionPath: rejects an empty string", () => {
  assert.equal(isSessionPath(""), false);
});

test("isSessionPath: rejects projects/<encoded>.jsonl without uuid structure", () => {
  assert.equal(isSessionPath("projects/-home-user/foo.jsonl"), false);
});

// ---------------------------------------------------------------------------
// sessionUuid
// ---------------------------------------------------------------------------

test("sessionUuid: extracts UUID from a valid session path", () => {
  assert.equal(
    sessionUuid("projects/-home-alice/550e8400-e29b-41d4-a716-446655440000.jsonl"),
    "550e8400-e29b-41d4-a716-446655440000",
  );
});

test("sessionUuid: returns null for a non-session path", () => {
  assert.equal(sessionUuid("settings.json"), null);
});

test("sessionUuid: returns null for an empty string", () => {
  assert.equal(sessionUuid(""), null);
});

// ---------------------------------------------------------------------------
// decodeProjectCwd
// ---------------------------------------------------------------------------

test("decodeProjectCwd: decodes an absolute Linux home dir", () => {
  // -home-alice-project → /home/alice/project (best-effort; ambiguous with -home-alice-pro/ject etc.)
  const result = decodeProjectCwd(
    "projects/-home-alice-project/550e8400-e29b-41d4-a716-446655440000.jsonl",
  );
  assert.equal(result, "/home/alice/project");
});

test("decodeProjectCwd: leading dash becomes leading slash", () => {
  const result = decodeProjectCwd(
    "projects/-home-b007ab1e-_src-_dev-my-app/550e8400-e29b-41d4-a716-446655440000.jsonl",
  );
  // All dashes become slashes for best-effort display.
  assert.equal(result, "/home/b007ab1e/_src/_dev/my/app");
});

test("decodeProjectCwd: no leading dash treated as relative", () => {
  const result = decodeProjectCwd(
    "projects/myproject/550e8400-e29b-41d4-a716-446655440000.jsonl",
  );
  assert.equal(result, "myproject");
});

test("decodeProjectCwd: single segment absolute path", () => {
  const result = decodeProjectCwd(
    "projects/-root/550e8400-e29b-41d4-a716-446655440000.jsonl",
  );
  assert.equal(result, "/root");
});

test("decodeProjectCwd: returns null for non-session path", () => {
  assert.equal(decodeProjectCwd("settings.json"), null);
});

test("decodeProjectCwd: returns null for empty string", () => {
  assert.equal(decodeProjectCwd(""), null);
});

// ---------------------------------------------------------------------------
// sessionInfo
// ---------------------------------------------------------------------------

test("sessionInfo: isSession=true with cwd and uuid for a session path", () => {
  const info = sessionInfo(
    "projects/-home-alice-myapp/550e8400-e29b-41d4-a716-446655440000.jsonl",
  );
  assert.equal(info.isSession, true);
  assert.equal(info.uuid, "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(info.cwd, "/home/alice/myapp");
});

test("sessionInfo: isSession=false for a non-session jsonl", () => {
  const info = sessionInfo("some/other/file.jsonl");
  assert.equal(info.isSession, false);
  assert.equal(info.cwd, null);
  assert.equal(info.uuid, null);
});

test("sessionInfo: isSession=false for settings.json", () => {
  const info = sessionInfo("settings.json");
  assert.equal(info.isSession, false);
  assert.equal(info.cwd, null);
  assert.equal(info.uuid, null);
});

test("sessionInfo: isSession=false for empty string", () => {
  const info = sessionInfo("");
  assert.equal(info.isSession, false);
  assert.equal(info.cwd, null);
  assert.equal(info.uuid, null);
});

// ---------------------------------------------------------------------------
// extractSessionCwd
// ---------------------------------------------------------------------------

test("extractSessionCwd returns the first record's cwd (the real path)", () => {
  const jsonl =
    '{"type":"meta","sessionId":"x"}\n' +
    '{"type":"user","cwd":"/home/b007ab1e/_src/_dev/tmux-session","message":{}}\n';
  assert.equal(extractSessionCwd(jsonl), "/home/b007ab1e/_src/_dev/tmux-session");
});

test("extractSessionCwd skips blank and non-JSON lines", () => {
  const jsonl = '\n   \nnot json\n{"role":"user","cwd":"/work/proj"}\n';
  assert.equal(extractSessionCwd(jsonl), "/work/proj");
});

test("extractSessionCwd returns null when no record has a cwd", () => {
  assert.equal(extractSessionCwd('{"type":"meta"}\n{"role":"user","message":{}}\n'), null);
  assert.equal(extractSessionCwd(""), null);
});

test("extractSessionCwd ignores non-string / empty cwd values", () => {
  assert.equal(extractSessionCwd('{"cwd":123}\n{"cwd":""}\n{"cwd":"/real"}\n'), "/real");
});

test("extractSessionCwd respects the maxLines scan limit", () => {
  const jsonl = "{}\n".repeat(10) + '{"cwd":"/late"}\n';
  assert.equal(extractSessionCwd(jsonl, 5), null);
  assert.equal(extractSessionCwd(jsonl, 50), "/late");
});
