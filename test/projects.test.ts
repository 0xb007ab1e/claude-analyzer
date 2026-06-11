/**
 * Tests for project-map helpers.
 *
 * Covers:
 *  - decodeProjectCwd: the critical decode function (100% branch coverage required
 *    as this is the core heuristic the feature relies on).
 *  - listProjects: integration-style tests over a temp fixture directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProjectCwd, listProjects, SESSION_CAP } from "../src/projects.ts";

// ---------------------------------------------------------------------------
// decodeProjectCwd unit tests
// ---------------------------------------------------------------------------

test("decodeProjectCwd: absolute path with no dashes in segments", () => {
  assert.equal(decodeProjectCwd("-home-alice-myrepo"), "/home/alice/myrepo");
});

test("decodeProjectCwd: absolute path — leading dash becomes leading slash", () => {
  assert.equal(decodeProjectCwd("-root"), "/root");
});

test("decodeProjectCwd: single-segment absolute path", () => {
  assert.equal(decodeProjectCwd("-home"), "/home");
});

test("decodeProjectCwd: deeply nested absolute path", () => {
  assert.equal(
    decodeProjectCwd("-home-user-src-dev-myproject"),
    "/home/user/src/dev/myproject",
  );
});

test("decodeProjectCwd: empty string returns '/'", () => {
  assert.equal(decodeProjectCwd(""), "/");
});

test("decodeProjectCwd: no leading dash treated as relative/fallback", () => {
  // Without a leading dash, dashes are still converted to slashes (best-effort).
  assert.equal(decodeProjectCwd("home-user"), "home/user");
});

test("decodeProjectCwd: single dash (just separator) becomes '/'", () => {
  // A lone dash encodes an absolute root: `-` → leading `/` + empty tail.
  assert.equal(decodeProjectCwd("-"), "/");
});

test("decodeProjectCwd: path with digits and underscores preserved", () => {
  assert.equal(
    decodeProjectCwd("-home-b007ab1e-_src-_dev"),
    "/home/b007ab1e/_src/_dev",
  );
});

test("decodeProjectCwd: realistic Claude Code example (no dashes in segment names)", () => {
  // Paths whose segments contain no literal dashes round-trip cleanly.
  assert.equal(
    decodeProjectCwd("-home-b007ab1e-_src-myproject"),
    "/home/b007ab1e/_src/myproject",
  );
});

test("decodeProjectCwd: ambiguous dashes — heuristic converts all dashes to slashes", () => {
  // Paths with literal dashes in segment names are ambiguous: every dash becomes
  // a slash. This is the documented best-effort behaviour; callers should label
  // the result as heuristic.
  assert.equal(
    decodeProjectCwd("-home-user-my-project"),
    "/home/user/my/project", // "my-project" → "my/project" (ambiguous)
  );
});

// ---------------------------------------------------------------------------
// listProjects integration tests over a temp fixture directory
// ---------------------------------------------------------------------------

/** Build a minimal temp root with a projects/ subtree. */
function makeTestRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "analyzer-projects-test-")));
  mkdirSync(join(dir, "projects"), { recursive: true });
  return dir;
}

test("listProjects: returns empty array when projects/ does not exist", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "analyzer-projects-empty-")));
  // No projects/ directory created.
  const result = await listProjects(root);
  assert.deepEqual(result, []);
});

test("listProjects: returns empty array when projects/ is empty", async () => {
  const root = makeTestRoot();
  const result = await listProjects(root);
  assert.deepEqual(result, []);
});

test("listProjects: lists one project with its sessions", async () => {
  const root = makeTestRoot();
  const projDir = join(root, "projects", "-home-alice-myrepo");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"), "line1\nline2\n");
  writeFileSync(join(projDir, "11111111-2222-3333-4444-555555555555.jsonl"), "a");

  const result = await listProjects(root);
  assert.equal(result.length, 1);
  const proj = result[0]!;
  assert.equal(proj.encoded, "-home-alice-myrepo");
  assert.equal(proj.cwd, "/home/alice/myrepo");
  assert.equal(proj.sessionCount, 2);
  assert.equal(proj.sessions.length, 2);
  assert.equal(proj.truncated, false);
  assert.equal(typeof proj.exists, "boolean");
  assert.equal(typeof proj.lastUsed, "number");
  assert.ok(proj.lastUsed > 0);
});

test("listProjects: session entries have correct uuid (no .jsonl), path, size, mtime", async () => {
  const root = makeTestRoot();
  const projDir = join(root, "projects", "-home-bob-work");
  mkdirSync(projDir, { recursive: true });
  const content = "hello session";
  writeFileSync(join(projDir, "my-session-uuid.jsonl"), content);

  const result = await listProjects(root);
  assert.equal(result.length, 1);
  const sess = result[0]!.sessions[0]!;
  assert.equal(sess.uuid, "my-session-uuid");
  assert.equal(sess.size, Buffer.byteLength(content));
  assert.ok(sess.mtime > 0);
  // path must be root-relative forward-slash form ending in the filename.
  assert.ok(sess.path.endsWith("my-session-uuid.jsonl"), `path: ${sess.path}`);
  assert.ok(!sess.path.startsWith("/"), `path must be relative: ${sess.path}`);
});

test("listProjects: ignores non-.jsonl files in a project directory", async () => {
  const root = makeTestRoot();
  const projDir = join(root, "projects", "-home-carol-stuff");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "session.jsonl"), "{}");
  writeFileSync(join(projDir, "notes.txt"), "not a session");
  writeFileSync(join(projDir, "config.json"), "{}");

  const result = await listProjects(root);
  assert.equal(result[0]!.sessionCount, 1);
  assert.equal(result[0]!.sessions[0]!.uuid, "session");
});

test("listProjects: sorted by lastUsed descending", async () => {
  const root = makeTestRoot();

  // Create two projects; write files so their mtimes differ.
  const projA = join(root, "projects", "-home-user-alpha");
  const projB = join(root, "projects", "-home-user-beta");
  mkdirSync(projA, { recursive: true });
  mkdirSync(projB, { recursive: true });

  writeFileSync(join(projA, "old.jsonl"), "a");
  // Brief delay to ensure a different mtime for projB's file.
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(projB, "new.jsonl"), "b");

  const result = await listProjects(root);
  assert.equal(result.length, 2);
  // The newer file should come first.
  assert.equal(result[0]!.encoded, "-home-user-beta");
  assert.equal(result[1]!.encoded, "-home-user-alpha");
});

test("listProjects: truncated flag set when sessions exceed SESSION_CAP", async () => {
  const root = makeTestRoot();
  const projDir = join(root, "projects", "-home-user-bigproject");
  mkdirSync(projDir, { recursive: true });

  // Create SESSION_CAP + 2 session files.
  const total = SESSION_CAP + 2;
  for (let i = 0; i < total; i++) {
    writeFileSync(join(projDir, `session-${String(i).padStart(4, "0")}.jsonl`), "x");
  }

  const result = await listProjects(root);
  assert.equal(result.length, 1);
  const proj = result[0]!;
  assert.equal(proj.sessionCount, total);
  assert.equal(proj.sessions.length, SESSION_CAP);
  assert.equal(proj.truncated, true);
});

test("listProjects: project with no sessions has sessionCount 0 and lastUsed 0", async () => {
  const root = makeTestRoot();
  mkdirSync(join(root, "projects", "-home-user-empty"), { recursive: true });

  const result = await listProjects(root);
  assert.equal(result[0]!.sessionCount, 0);
  assert.equal(result[0]!.sessions.length, 0);
  assert.equal(result[0]!.lastUsed, 0);
  assert.equal(result[0]!.truncated, false);
});
