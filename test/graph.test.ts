/**
 * Unit tests for the relationship-graph helpers.
 *
 * Covers:
 *  - UUID extraction from strings (paths, names, mixed content)
 *  - Graph construction: nodes, edges, degrees
 *  - Adjacency correctness: shared UUID creates edges; unrelated files don't
 *  - Graph trimming (degree-based cap + truncated flag)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUuids, buildGraph, trimGraph, GRAPH_NODE_CAP } from "../src/graph.ts";

// ─── extractUuids ────────────────────────────────────────────────────────────

test("extractUuids: returns empty array for a string with no UUIDs", () => {
  assert.deepEqual(extractUuids(""), []);
  assert.deepEqual(extractUuids("no-uuid-here"), []);
  assert.deepEqual(extractUuids("projects/abc/settings.json"), []);
});

test("extractUuids: extracts a single UUID from a file path", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const result = extractUuids(`projects/enc/${uuid}.jsonl`);
  assert.deepEqual(result, [uuid]);
});

test("extractUuids: extracts multiple distinct UUIDs from one string", () => {
  const a = "550e8400-e29b-41d4-a716-446655440000";
  const b = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  const result = extractUuids(`${a}/transcript/${b}.log`);
  assert.ok(result.includes(a));
  assert.ok(result.includes(b));
  assert.equal(result.length, 2);
});

test("extractUuids: de-duplicates UUIDs that appear more than once", () => {
  const uuid = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  const result = extractUuids(`${uuid}/${uuid}`);
  assert.deepEqual(result, [uuid]);
});

test("extractUuids: normalises to lower-case", () => {
  const upper = "550E8400-E29B-41D4-A716-446655440000";
  const lower = upper.toLowerCase();
  assert.deepEqual(extractUuids(upper), [lower]);
});

test("extractUuids: does NOT match a string that is too short or malformed", () => {
  // Missing last group segment — only 4 groups, never 5.
  assert.deepEqual(extractUuids("550e8400-e29b-41d4-a716"), []);
  // Wrong group lengths where no valid UUID sub-sequence is present.
  // "zzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz" — non-hex chars, not matchable.
  assert.deepEqual(extractUuids("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"), []);
  // A plain hex string without hyphens is not a UUID.
  assert.deepEqual(extractUuids("550e8400e29b41d4a716446655440000"), []);
});

// ─── buildGraph ──────────────────────────────────────────────────────────────

test("buildGraph: empty input produces empty graph", () => {
  const { nodes, edges } = buildGraph([]);
  assert.equal(nodes.length, 0);
  assert.equal(edges.length, 0);
});

test("buildGraph: paths without UUIDs produce no nodes or edges", () => {
  const { nodes, edges } = buildGraph(["projects/settings.json", "CLAUDE.md"]);
  assert.equal(nodes.length, 0);
  assert.equal(edges.length, 0);
});

test("buildGraph: one file with one UUID produces two nodes and one edge", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const file = `projects/enc/${uuid}.jsonl`;
  const { nodes, edges } = buildGraph([file]);

  assert.equal(nodes.length, 2);
  assert.equal(edges.length, 1);

  const uuidNode = nodes.find((n) => n.type === "uuid");
  const fileNode = nodes.find((n) => n.type === "file");
  assert.ok(uuidNode, "uuid node present");
  assert.ok(fileNode, "file node present");
  assert.equal(uuidNode!.id, uuid);
  assert.equal(fileNode!.path, file);
  assert.equal(uuidNode!.degree, 1);
  assert.equal(fileNode!.degree, 1);
});

test("buildGraph: two files sharing a UUID are both connected to that UUID node", () => {
  const uuid = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  const fileA = `projects/enc/${uuid}.jsonl`;
  const fileB = `cot/transcript/${uuid}.log`;
  const { nodes, edges } = buildGraph([fileA, fileB]);

  // 1 uuid node + 2 file nodes = 3 nodes; 2 edges
  assert.equal(nodes.length, 3);
  assert.equal(edges.length, 2);

  const uuidNode = nodes.find((n) => n.type === "uuid")!;
  assert.equal(uuidNode.degree, 2, "uuid node connects to both files");

  const fileNodes = nodes.filter((n) => n.type === "file");
  for (const fn of fileNodes) {
    assert.equal(fn.degree, 1);
  }
});

test("buildGraph: two files with different UUIDs produce no shared UUID node", () => {
  const uuidA = "550e8400-e29b-41d4-a716-446655440000";
  const uuidB = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  const { nodes, edges } = buildGraph([
    `projects/${uuidA}.jsonl`,
    `projects/${uuidB}.jsonl`,
  ]);
  // 2 uuid nodes + 2 file nodes = 4; 2 separate edges (no cross-link)
  assert.equal(nodes.length, 4);
  assert.equal(edges.length, 2);
});

test("buildGraph: a file path containing two UUIDs produces edges to both", () => {
  const uuidA = "550e8400-e29b-41d4-a716-446655440000";
  const uuidB = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  const file = `${uuidA}/sub/${uuidB}.log`;
  const { nodes, edges } = buildGraph([file]);

  // 2 uuid nodes + 1 file node = 3; 2 edges
  assert.equal(nodes.length, 3);
  assert.equal(edges.length, 2);

  const fileNode = nodes.find((n) => n.type === "file")!;
  assert.equal(fileNode.degree, 2, "file connects to both UUIDs");
});

test("buildGraph: file label is the basename of the path", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const { nodes } = buildGraph([`deep/nested/${uuid}.jsonl`]);
  const fileNode = nodes.find((n) => n.type === "file")!;
  assert.equal(fileNode.label, `${uuid}.jsonl`);
});

test("buildGraph: case-insensitive UUID matching (path with uppercase)", () => {
  const uuidLower = "550e8400-e29b-41d4-a716-446655440000";
  const uuidUpper = uuidLower.toUpperCase();
  // Two paths — one lowercase, one uppercase — reference the SAME logical UUID.
  const { nodes, edges } = buildGraph([
    `projects/${uuidLower}.jsonl`,
    `cot/${uuidUpper}.log`,
  ]);
  // Should see ONE uuid node (normalised lower), two file nodes, two edges.
  const uuidNodes = nodes.filter((n) => n.type === "uuid");
  assert.equal(uuidNodes.length, 1, "upper and lower UUIDs normalise to one node");
  assert.equal(edges.length, 2);
  assert.equal(uuidNodes[0]!.degree, 2);
});

// ─── trimGraph ───────────────────────────────────────────────────────────────

test("trimGraph: does not truncate when node count is within cap", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const graph = buildGraph([`a/${uuid}.log`]);
  const result = trimGraph(graph);
  assert.equal(result.truncated, false);
  assert.equal(result.nodes.length, graph.nodes.length);
  assert.equal(result.edges.length, graph.edges.length);
});

test("trimGraph: truncates to GRAPH_NODE_CAP and sets truncated=true", () => {
  // Generate enough paths so the resulting graph has > GRAPH_NODE_CAP nodes.
  // Each path uses a unique UUID → each adds 1 uuid node + 1 file node = 2 nodes.
  // We need GRAPH_NODE_CAP / 2 + 1 paths to exceed the cap.
  const count = Math.floor(GRAPH_NODE_CAP / 2) + 5;
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    // Construct deterministic fake UUIDs by zero-padding a counter.
    const hex = i.toString(16).padStart(8, "0");
    const uuid = `${hex}-0000-0000-0000-000000000000`;
    paths.push(`projects/${uuid}.jsonl`);
  }
  const graph = buildGraph(paths);
  assert.ok(graph.nodes.length > GRAPH_NODE_CAP, "pre-condition: graph exceeds cap");

  const result = trimGraph(graph);
  assert.equal(result.truncated, true);
  assert.ok(result.nodes.length <= GRAPH_NODE_CAP, "trimmed to cap");
});

test("trimGraph: retained nodes are the highest-degree ones", () => {
  // Build a graph where one UUID is shared by many files (high degree)
  // and the rest are singletons. After trimming the high-degree hub must survive.
  const hub = "aaaaaaaa-0000-0000-0000-000000000000";
  const paths: string[] = [];
  // Hub UUID in 10 files — degree 10 (for the uuid node) and 1 (for each file node)
  for (let i = 0; i < 10; i++) {
    paths.push(`file-${i}/${hub}.log`);
  }
  // Many singleton UUIDs to push graph beyond cap
  const singletonCount = Math.floor(GRAPH_NODE_CAP / 2) + 5;
  for (let i = 0; i < singletonCount; i++) {
    const hex = (i + 1).toString(16).padStart(8, "0");
    const uuid = `${hex}-bbbb-bbbb-bbbb-bbbbbbbbbbbb`;
    paths.push(`solo/${uuid}.txt`);
  }
  const graph = buildGraph(paths);
  const result = trimGraph(graph);

  // The hub uuid node (degree 10) must be retained.
  assert.ok(
    result.nodes.some((n) => n.id === hub),
    "high-degree hub uuid node is retained after trimming",
  );
});

test("trimGraph: pruned edges have both endpoints in retained node set", () => {
  const count = Math.floor(GRAPH_NODE_CAP / 2) + 5;
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const hex = i.toString(16).padStart(8, "0");
    paths.push(`projects/${hex}-0000-0000-0000-000000000000.jsonl`);
  }
  const result = trimGraph(buildGraph(paths));
  const keptIds = new Set(result.nodes.map((n) => n.id));
  for (const edge of result.edges) {
    assert.ok(keptIds.has(edge.source), "edge source is in retained nodes");
    assert.ok(keptIds.has(edge.target), "edge target is in retained nodes");
  }
});
