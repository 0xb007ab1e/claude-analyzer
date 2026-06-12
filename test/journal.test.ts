/**
 * Tests for the persistent event journal: location resolution (kept outside the
 * watched root), append/query roundtrip, kind/since/limit filtering, field
 * sanitisation (no stray/secret fields persisted), rotation to a single backup,
 * and the pure aggregation helper.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Journal,
  defaultStateDir,
  resolveJournalDir,
  aggregateEvents,
  summarizeEvents,
  type JournalEvent,
} from "../src/journal.ts";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "ca-journal-")));
}

const DAY = 86_400_000;

test("defaultStateDir honours XDG_STATE_HOME, else ~/.local/state", () => {
  assert.equal(
    defaultStateDir({ XDG_STATE_HOME: "/x/state", HOME: "/home/u" }),
    "/x/state/claude-analyzer",
  );
  assert.equal(
    defaultStateDir({ HOME: "/home/u" }),
    "/home/u/.local/state/claude-analyzer",
  );
});

test("resolveJournalDir never lands inside the watched root", () => {
  // Normal case: state dir is elsewhere → returned as-is.
  const normal = resolveJournalDir("/srv/.claude", { XDG_STATE_HOME: "/var/state", HOME: "/home/u" });
  assert.equal(normal, "/var/state/claude-analyzer");
  // Pathological: root encloses the default state dir → fall back to a temp path.
  const enclosing = resolveJournalDir("/home/u", { HOME: "/home/u" });
  assert.ok(!enclosing.startsWith("/home/u/"), `should escape root, got ${enclosing}`);
});

test("record + query roundtrips newest-first with filters", async () => {
  const j = new Journal(tmp());
  await j.record({ ts: 100, kind: "fschange", path: "a.txt", op: "change" });
  await j.record({ ts: 200, kind: "audit", msg: "reveal raw settings" });
  await j.record({ ts: 300, kind: "fschange", path: "b.txt", op: "rename" });

  const all = await j.query();
  assert.deepEqual(all.map((e) => e.ts), [300, 200, 100]); // newest first

  const onlyFs = await j.query({ kinds: ["fschange"] });
  assert.deepEqual(onlyFs.map((e) => e.path), ["b.txt", "a.txt"]);

  const since = await j.query({ sinceMs: 250 });
  assert.deepEqual(since.map((e) => e.ts), [300]);

  const limited = await j.query({ limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0]?.ts, 300);
});

test("record persists only allow-listed fields (no secret leakage)", async () => {
  const j = new Journal(tmp());
  // Cast through unknown to smuggle an extra field a caller might pass by mistake.
  await j.record({ ts: 1, kind: "audit", msg: "x", secret: "sk-ant-LEAK" } as unknown as JournalEvent);
  const [ev] = await j.query();
  assert.ok(ev);
  assert.equal((ev as Record<string, unknown>)["secret"], undefined);
  assert.deepEqual(Object.keys(ev!).sort(), ["kind", "msg", "ts"]);
});

test("active file rotates to a single .1 backup and query spans both", async () => {
  const dir = tmp();
  const j = new Journal(dir, { maxBytes: 200 }); // tiny cap forces rotation
  for (let i = 0; i < 20; i++) {
    await j.record({ ts: 1000 + i, kind: "fschange", path: `file-${i}.txt`, op: "change" });
  }
  assert.ok(existsSync(join(dir, "events.jsonl.1")), "backup file should exist after rotation");
  const all = await j.query({ limit: 5000 });
  // Most recent survives; events from before rotation are still readable via .1.
  assert.equal(all[0]?.ts, 1019);
  assert.ok(all.length > 1);
});

test("query tolerates a torn/partial trailing line", async () => {
  const dir = tmp();
  const j = new Journal(dir);
  await j.record({ ts: 1, kind: "audit", msg: "ok" });
  // Append a garbage half-line directly.
  const { appendFile } = await import("node:fs/promises");
  await appendFile(join(dir, "events.jsonl"), '{"ts":2,"kind":"aud', "utf8");
  const all = await j.query();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.ts, 1);
});

test("query filters by path and by until/since window", async () => {
  const j = new Journal(tmp());
  await j.record({ ts: 100, kind: "fschange", path: "a.txt", op: "change" });
  await j.record({ ts: 200, kind: "fschange", path: "b.txt", op: "rename" });
  await j.record({ ts: 300, kind: "fschange", path: "a.txt", op: "change" });

  const onlyA = await j.query({ path: "a.txt" });
  assert.deepEqual(onlyA.map((e) => e.ts), [300, 100]);

  const windowed = await j.query({ sinceMs: 150, untilMs: 250 });
  assert.deepEqual(windowed.map((e) => e.ts), [200]);
});

test("stats reports bytes, count, and oldest/newest span", async () => {
  const j = new Journal(tmp());
  const empty = await j.stats();
  assert.equal(empty.events, 0);
  assert.equal(empty.oldestMs, null);

  await j.record({ ts: 500, kind: "audit", msg: "x" });
  await j.record({ ts: 100, kind: "fschange", path: "a", op: "change" });
  await j.record({ ts: 900, kind: "fschange", path: "b", op: "change" });
  const s = await j.stats();
  assert.equal(s.events, 3);
  assert.equal(s.oldestMs, 100);
  assert.equal(s.newestMs, 900);
  assert.ok(s.bytes > 0);
});

test("summarizeEvents reports count, span, kind/op breakdowns, top paths", () => {
  const summary = summarizeEvents([
    { ts: 10, kind: "fschange", path: "x", op: "change" },
    { ts: 30, kind: "fschange", path: "x", op: "rename" },
    { ts: 20, kind: "audit", msg: "reveal x" },
  ]);
  assert.equal(summary.count, 3);
  assert.equal(summary.firstTs, 10);
  assert.equal(summary.lastTs, 30);
  assert.deepEqual(summary.byKind, { fschange: 2, audit: 1 });
  assert.deepEqual(summary.byOp, { change: 1, rename: 1 });
  assert.equal(summary.topPaths[0]?.path, "x");
  assert.equal(summary.topPaths[0]?.count, 2);
});

test("aggregateEvents buckets by day/hour/kind and ranks top paths", () => {
  const now = 10 * DAY + 5 * 3_600_000; // day 10, 05:00 UTC
  const events: JournalEvent[] = [
    { ts: now, kind: "fschange", path: "hot.txt" },
    { ts: now - 1000, kind: "fschange", path: "hot.txt" },
    { ts: now - 2 * DAY, kind: "audit", path: "cold.txt" },
    { ts: now - 400 * DAY, kind: "fschange", path: "ancient.txt" }, // outside window
  ];
  const agg = aggregateEvents(events, now, 7);
  assert.equal(agg.total, 3); // ancient excluded
  assert.deepEqual(agg.byKind, { fschange: 2, audit: 1 });
  assert.equal(agg.topPaths[0]?.path, "hot.txt");
  assert.equal(agg.topPaths[0]?.count, 2);
  assert.equal(agg.days.length, 7);
  assert.equal(agg.byHour.length, 24);
  assert.equal(agg.byHour.reduce((s, n) => s + n, 0), 3);
});
