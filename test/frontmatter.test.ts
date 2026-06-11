/**
 * Tests for the YAML-ish frontmatter parser.
 *
 * Covers the key shapes found in ~/.claude/agents/*.md and
 * ~/.claude/skills/{star}/SKILL.md, plus edge cases for correctness.
 *
 * Per the project testing mandate the parser is a critical-path module;
 * these tests aim for full branch coverage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../src/frontmatter.ts";

// ---------------------------------------------------------------------------
// No frontmatter
// ---------------------------------------------------------------------------

test("returns empty frontmatter when there is no --- block", () => {
  const text = "# Just a markdown heading\n\nsome body text";
  const { frontmatter, body } = parseFrontmatter(text);
  assert.deepEqual(frontmatter, {});
  assert.equal(body, text);
});

test("returns empty frontmatter for an empty string", () => {
  const { frontmatter, body } = parseFrontmatter("");
  assert.deepEqual(frontmatter, {});
  assert.equal(body, "");
});

test("returns empty frontmatter when opening --- is present but no closing ---", () => {
  const text = "---\nname: foo\n";
  const { frontmatter, body } = parseFrontmatter(text);
  assert.deepEqual(frontmatter, {});
  assert.equal(body, text);
});

// ---------------------------------------------------------------------------
// Basic key: value pairs
// ---------------------------------------------------------------------------

test("parses a simple key: value pair", () => {
  const text = "---\nname: hello\n---\nbody";
  const { frontmatter, body } = parseFrontmatter(text);
  assert.equal(frontmatter.name, "hello");
  assert.equal(body.trim(), "body");
});

test("parses multiple simple keys", () => {
  const text = "---\nname: foo\ncolor: green\ntools: Read, Write\n---\nbody";
  const { frontmatter } = parseFrontmatter(text);
  assert.equal(frontmatter.name, "foo");
  assert.equal(frontmatter.color, "green");
  assert.equal(frontmatter.tools, "Read, Write");
});

test("trims key and value", () => {
  const { frontmatter } = parseFrontmatter("---\n  name:   spacy  \n---\n");
  assert.equal(frontmatter.name, "spacy");
});

// ---------------------------------------------------------------------------
// Quoted strings
// ---------------------------------------------------------------------------

test("strips double quotes from quoted values", () => {
  const { frontmatter } = parseFrontmatter('---\nname: "quoted value"\n---\n');
  assert.equal(frontmatter.name, "quoted value");
});

test("strips single quotes from quoted values", () => {
  const { frontmatter } = parseFrontmatter("---\nname: 'single quoted'\n---\n");
  assert.equal(frontmatter.name, "single quoted");
});

// ---------------------------------------------------------------------------
// Folded block scalar (>- / >)
// ---------------------------------------------------------------------------

test("parses a folded block scalar (>-) as a single space-joined string", () => {
  const text = "---\ndescription: >-\n  Line one\n  line two\n  line three\n---\nbody";
  const { frontmatter } = parseFrontmatter(text);
  assert.equal(frontmatter.description, "Line one line two line three");
});

test("parses a folded block scalar (>) similarly (strip trailing)", () => {
  const text = "---\ndescription: >\n  hello\n  world\n---\n";
  const { frontmatter } = parseFrontmatter(text);
  assert.equal(frontmatter.description, "hello world");
});

test("block scalar: stops at next top-level key", () => {
  const text = "---\ndescription: >-\n  Part one\n  part two\nname: after\n---\n";
  const { frontmatter } = parseFrontmatter(text);
  assert.equal(frontmatter.description, "Part one part two");
  assert.equal(frontmatter.name, "after");
});

// ---------------------------------------------------------------------------
// Literal block scalar (|-  / |)
// ---------------------------------------------------------------------------

test("parses a literal block scalar (|-) preserving internal newlines", () => {
  const text = "---\nbody: |-\n  line one\n  line two\n---\n";
  const { frontmatter } = parseFrontmatter(text);
  assert.equal(frontmatter.body, "line one\nline two");
});

// ---------------------------------------------------------------------------
// Inline lists [a, b, c]
// ---------------------------------------------------------------------------

test("parses an inline list", () => {
  const text = "---\ntools: [Read, Grep, Write]\n---\n";
  const { frontmatter } = parseFrontmatter(text);
  assert.deepEqual(frontmatter.tools, ["Read", "Grep", "Write"]);
});

test("inline list strips quotes around items", () => {
  const text = '---\ntools: ["Read", "Write"]\n---\n';
  const { frontmatter } = parseFrontmatter(text);
  assert.deepEqual(frontmatter.tools, ["Read", "Write"]);
});

test("empty inline list returns an empty array", () => {
  const { frontmatter } = parseFrontmatter("---\ntools: []\n---\n");
  assert.deepEqual(frontmatter.tools, []);
});

// ---------------------------------------------------------------------------
// Nested sub-mapping (one level)
// ---------------------------------------------------------------------------

test("parses a one-level sub-mapping", () => {
  const text = "---\nmetadata:\n  role: Engineer\n  tier: 2\n---\n";
  const { frontmatter } = parseFrontmatter(text);
  const meta = frontmatter.metadata as Record<string, string>;
  assert.equal(meta.role, "Engineer");
  assert.equal(meta.tier, "2");
});

// ---------------------------------------------------------------------------
// Real-world agent frontmatter shapes
// ---------------------------------------------------------------------------

test("parses a real sdlc-backend-engineer agent frontmatter", () => {
  const text = [
    "---",
    "name: sdlc-backend-engineer",
    "description: >-",
    "  Delegated Backend Engineer worker. The Software Architect spawns this to implement",
    "  a server-side slice.",
    "tools: Read, Grep, Glob, Write, Edit, Bash",
    "isolation: worktree",
    "skills: sdlc-backend-engineer",
    "color: green",
    "---",
    "",
    "You are a **delegated Backend Engineer**.",
  ].join("\n");

  const { frontmatter, body } = parseFrontmatter(text);
  assert.equal(frontmatter.name, "sdlc-backend-engineer");
  assert.ok(
    (frontmatter.description as string).includes("Delegated Backend Engineer"),
    "description should contain expected text",
  );
  assert.equal(frontmatter.color, "green");
  assert.equal(frontmatter.isolation, "worktree");
  assert.ok(body.includes("You are a"), "body should contain prose");
});

test("parses agent with disallowedTools multi-line inline value", () => {
  const text = [
    "---",
    "name: sdlc-gate-executor",
    "disallowedTools: Bash(git push *), Bash(git merge *), Bash(rm -rf *)",
    "color: green",
    "---",
  ].join("\n");

  const { frontmatter } = parseFrontmatter(text);
  assert.equal(frontmatter.name, "sdlc-gate-executor");
  // disallowedTools is a bare (comma-separated) string value
  assert.ok((frontmatter.disallowedTools as string).includes("Bash(git push"));
});

test("parses a real SKILL.md frontmatter", () => {
  const text = [
    "---",
    "name: SDLC Backend Engineer",
    "description: >-",
    "  Implements server-side application code under the Software Architect.",
    'argument-hint: "[backend task]"',
    "allowed-tools: Read, Grep, Glob, Write, Edit, Bash",
    "metadata:",
    "  role: Backend Engineer",
    "  tier: 2",
    "  reports_to: sdlc-software-architect",
    "  can_delegate: false",
    "---",
    "",
    "# Role: SDLC Backend Engineer",
  ].join("\n");

  const { frontmatter, body } = parseFrontmatter(text);
  assert.equal(frontmatter.name, "SDLC Backend Engineer");
  assert.ok((frontmatter.description as string).includes("server-side"));
  assert.equal(frontmatter["argument-hint"], "[backend task]");
  const meta = frontmatter.metadata as Record<string, string>;
  assert.equal(meta.role, "Backend Engineer");
  assert.equal(meta.tier, "2");
  assert.ok(body.includes("Role: SDLC Backend Engineer"));
});

// ---------------------------------------------------------------------------
// Body extraction
// ---------------------------------------------------------------------------

test("body is empty string when nothing follows the closing ---", () => {
  const { body } = parseFrontmatter("---\nname: x\n---\n");
  assert.equal(body, "");
});

test("body retains all content including blank lines", () => {
  const { body } = parseFrontmatter("---\nname: x\n---\n\nLine1\n\nLine2\n");
  assert.ok(body.includes("Line1"));
  assert.ok(body.includes("Line2"));
});

// ---------------------------------------------------------------------------
// Blank lines and comments inside frontmatter
// ---------------------------------------------------------------------------

test("skips blank lines inside the frontmatter block", () => {
  const text = "---\nname: foo\n\ncolor: blue\n---\n";
  const { frontmatter } = parseFrontmatter(text);
  assert.equal(frontmatter.name, "foo");
  assert.equal(frontmatter.color, "blue");
});

test("leading blank lines before opening --- are ignored", () => {
  const { frontmatter } = parseFrontmatter("\n\n---\nname: x\n---\n");
  assert.equal(frontmatter.name, "x");
});

// ---------------------------------------------------------------------------
// Value with colon inside
// ---------------------------------------------------------------------------

test("only the first colon splits key from value", () => {
  const { frontmatter } = parseFrontmatter(
    "---\ncommand: /usr/bin/python3 /path/to/script.py gate\n---\n",
  );
  assert.equal(frontmatter.command, "/usr/bin/python3 /path/to/script.py gate");
});
