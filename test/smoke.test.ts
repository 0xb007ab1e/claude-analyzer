/**
 * HTTP smoke test — boots the real server as a child process against a
 * temporary root and exercises the API end to end. This makes the "server.ts /
 * files.ts are e2e-covered" claim concrete (they are run, just not imported, so
 * they stay out of the unit-coverage denominator).
 *
 * Hermetic: a throwaway tmp root with seeded files, a free ephemeral port, and
 * `XDG_STATE_HOME` redirected to tmp so the journal never touches real state.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(repoRoot, "src", "server.ts");

let child: ChildProcess;
let port: number;
let root: string;

/** Grab an OS-assigned free TCP port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(p));
    });
  });
}

/** Minimal HTTP GET that allows overriding the Host header (fetch forbids it). */
function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ca-smoke-root-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "ca-smoke-state-")));
  // Seed a couple of files.
  writeFileSync(join(root, "hello.txt"), "line 1\nline 2\nline 3\n");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "pic.png"), "not-really-a-png-but-extension-drives-type");

  port = await freePort();
  child = spawn(
    process.execPath,
    ["--experimental-strip-types", serverEntry, "--root", root, "--port", String(port), "--no-reload"],
    { env: { ...process.env, XDG_STATE_HOME: state }, stdio: "ignore" },
  );

  // Wait until it's accepting requests (or fail fast).
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      const r = await get("/api/config");
      if (r.status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start within 8s");
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(() => {
  child?.kill("SIGTERM");
});

test("GET /api/config reports the root and mode", async () => {
  const r = await get("/api/config");
  assert.equal(r.status, 200);
  const cfg = JSON.parse(r.body);
  assert.equal(cfg.root, root);
  assert.equal(cfg.allowWrite, true);
});

test("GET /api/list returns the seeded entries", async () => {
  const r = await get("/api/list?path=");
  assert.equal(r.status, 200);
  const data = JSON.parse(r.body);
  const names = (data.entries ?? data).map((e: { name: string }) => e.name);
  assert.ok(names.includes("hello.txt"), `expected hello.txt in ${JSON.stringify(names)}`);
});

test("GET /api/file-lines streams a line window", async () => {
  const r = await get("/api/file-lines?path=hello.txt&from=0&count=2");
  assert.equal(r.status, 200);
  const data = JSON.parse(r.body);
  assert.equal(data.total, 3);
  assert.equal(data.lines.length, 2);
  assert.equal(data.lines[0].text, "line 1");
});

test("GET /api/raw serves bytes with a type and nosniff", async () => {
  const r = await get("/api/raw?path=sub/pic.png");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "image/png");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
});

test("GET /api/raw rejects path traversal", async () => {
  const r = await get("/api/raw?path=../../etc/passwd");
  assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
});

test("a disallowed Host header is rejected (anti-DNS-rebinding)", async () => {
  const r = await get("/api/config", { host: "evil.example.com" });
  assert.equal(r.status, 403);
});

test("GET /api/metrics exposes RED metrics that reflect prior requests", async () => {
  const r = await get("/api/metrics");
  assert.equal(r.status, 200);
  const m = JSON.parse(r.body);
  assert.equal(typeof m.bootId, "string");
  assert.ok(m.requests > 0);
  assert.ok(m.byRoute["GET /api/config"]?.count >= 1);
  assert.equal(typeof m.latency.p95Ms, "number");
});

test("GET /api/observability returns an aggregate + metrics snapshot + journal stats", async () => {
  const r = await get("/api/observability?days=7");
  assert.equal(r.status, 200);
  const o = JSON.parse(r.body);
  assert.ok(o.aggregate && Array.isArray(o.aggregate.days));
  assert.equal(o.aggregate.days.length, 7);
  assert.ok(Array.isArray(o.recent));
  assert.ok(o.metrics && typeof o.metrics.requests === "number");
  // Per-route latency present in the snapshot.
  const route = o.metrics.byRoute["GET /api/config"];
  assert.ok(route && typeof route.avgMs === "number" && typeof route.maxMs === "number");
  assert.equal(typeof o.journalDir, "string");
  assert.ok(o.journal && typeof o.journal.events === "number" && typeof o.journal.bytes === "number");
});

test("GET /api/search finds seeded content; short query is rejected", async () => {
  const r = await get("/api/search?q=line");
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.ok(d.files.some((f: { path: string }) => f.path === "hello.txt"));
  assert.ok(d.totalMatches >= 3);
  const short = await get("/api/search?q=l");
  assert.equal(short.status, 400);
});

test("GET /api/journal returns a filtered slice + summary", async () => {
  const r = await get("/api/journal?kind=audit&limit=50");
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.ok(Array.isArray(d.events));
  assert.ok(d.summary && typeof d.summary.count === "number");
  assert.deepEqual(d.filter.kinds, ["audit"]);
  // Every returned event must match the requested kind.
  assert.ok(d.events.every((e: { kind: string }) => e.kind === "audit"));
});
