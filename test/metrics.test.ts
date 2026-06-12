/**
 * Tests for the in-process RED metrics store: route labelling, status classes,
 * latency histogram percentiles, counters, and the snapshot shape.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Metrics, routeLabel, statusClass, percentile, LATENCY_BUCKETS_MS } from "../src/metrics.ts";

test("routeLabel normalises to a bounded set of labels", () => {
  assert.equal(routeLabel("GET", "/api/file"), "GET /api/file");
  assert.equal(routeLabel("post", "/api/file"), "POST /api/file");
  assert.equal(routeLabel("GET", "/api/observability"), "GET /api/observability");
  assert.equal(routeLabel("GET", "/"), "static");
  assert.equal(routeLabel("GET", "/app.js"), "static");
  // Unknown /api/* path collapses to a single bucket (no cardinality blowup).
  assert.equal(routeLabel("GET", "/api/does-not-exist"), "other");
});

test("statusClass buckets by hundreds", () => {
  assert.equal(statusClass(200), "2xx");
  assert.equal(statusClass(404), "4xx");
  assert.equal(statusClass(500), "5xx");
  assert.equal(statusClass(0), "other");
});

test("percentile reads the histogram and returns a bucket bound", () => {
  // 10 fast (<=1ms) requests, 0 elsewhere → every percentile is the first bound.
  const fast = new Array(LATENCY_BUCKETS_MS.length + 1).fill(0);
  fast[0] = 10;
  assert.equal(percentile(fast, 0.5), LATENCY_BUCKETS_MS[0]);
  assert.equal(percentile(fast, 0.99), LATENCY_BUCKETS_MS[0]);
  // Empty histogram → 0.
  assert.equal(percentile(new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), 0.5), 0);
});

test("Metrics tallies requests, classes, routes, and latency", () => {
  const m = new Metrics("boot-1", 1000);
  m.recordRequest("GET /api/file", 200, 3);
  m.recordRequest("GET /api/file", 200, 7);
  m.recordRequest("GET /api/file", 404, 2);
  m.recordRequest("static", 500, 800);

  const s = m.snapshot(1000 + 5000, 12345);
  assert.equal(s.bootId, "boot-1");
  assert.equal(s.startMs, 1000);
  assert.equal(s.uptimeMs, 5000);
  assert.equal(s.rssBytes, 12345);
  assert.equal(s.requests, 4);
  assert.deepEqual(s.byClass, { "2xx": 2, "4xx": 1, "5xx": 1 });
  assert.equal(s.byRoute["GET /api/file"]?.count, 3);
  assert.deepEqual(s.byRoute["GET /api/file"]?.byClass, { "2xx": 2, "4xx": 1 });
  // Per-route latency: avg over the 3 /api/file durations (3,7,2), max = 7.
  assert.ok(Math.abs((s.byRoute["GET /api/file"]?.avgMs ?? 0) - (3 + 7 + 2) / 3) < 1e-9);
  assert.equal(s.byRoute["GET /api/file"]?.maxMs, 7);
  assert.equal(s.byRoute["static"]?.maxMs, 800);
  // 2 of 4 are 4xx/5xx.
  assert.equal(s.errorRate, 0.5);
  assert.equal(s.latency.count, 4);
  assert.equal(s.latency.maxMs, 800);
  assert.ok(Math.abs(s.latency.avgMs - (3 + 7 + 2 + 800) / 4) < 1e-9);
  // buckets array has one slot per bound plus overflow.
  assert.equal(s.latency.buckets.length, LATENCY_BUCKETS_MS.length + 1);
  assert.equal(s.latency.buckets.at(-1)?.leMs, null);
});

test("Metrics named counters accumulate", () => {
  const m = new Metrics("b", 0);
  m.incr("reveal");
  m.incr("reveal");
  m.incr("write", 3);
  const s = m.snapshot(0);
  assert.equal(s.counters["reveal"], 2);
  assert.equal(s.counters["write"], 3);
});

test("Metrics snapshot of an idle server is well-formed", () => {
  const s = new Metrics("b", 0).snapshot(0);
  assert.equal(s.requests, 0);
  assert.equal(s.errorRate, 0);
  assert.equal(s.latency.avgMs, 0);
  assert.deepEqual(s.counters, {});
});
