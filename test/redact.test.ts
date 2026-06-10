/**
 * Tests for secret redaction — secrets must never leak unless explicitly
 * revealed. Over-redaction is acceptable; under-redaction is a security bug.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isSensitivePath, redactText, isSensitiveKey } from "../src/redact.ts";

test("identifies whole-file-sensitive paths", () => {
  assert.equal(isSensitivePath(".credentials.json"), true);
  assert.equal(isSensitivePath("nested/dir/.credentials.json"), true);
  assert.equal(isSensitivePath("some/credentials/file.json"), true);
  assert.equal(isSensitivePath("token-store.json"), true);
  assert.equal(isSensitivePath("settings.json"), false);
  assert.equal(isSensitivePath("projects/x/session.jsonl"), false);
});

test("redacts sensitive JSON key/value pairs", () => {
  const input = '{"access_token": "abc123def456ghi", "name": "hi"}';
  const { text, redacted } = redactText(input);
  assert.equal(redacted, true);
  assert.match(text, /«redacted»/);
  assert.doesNotMatch(text, /abc123def456ghi/);
  assert.match(text, /"name": "hi"/); // non-sensitive preserved
});

test("redacts inline tokens regardless of key", () => {
  const samples = [
    "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
    "Authorization: Bearer abcdefghij1234567890",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "eyJhbGciOi.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4",
  ];
  for (const s of samples) {
    const { text, redacted } = redactText(`prefix ${s} suffix`);
    assert.equal(redacted, true, `should redact: ${s}`);
    assert.doesNotMatch(text, /AAAAAAAA|abcdefghij1234567890|ABCDEFGHIJKLMNOP|SflKxwRJSMeKKF2QT4/);
  }
});

test("whole-file-sensitive masks every leaf but keeps JSON shape", () => {
  const input = JSON.stringify({
    claudeAiOauth: { accessToken: "live-token-xyz", scopes: ["a", "b"] },
  });
  const { text, redacted } = redactText(input, { wholeFileSensitive: true });
  assert.equal(redacted, true);
  assert.doesNotMatch(text, /live-token-xyz/);
  const parsed = JSON.parse(text);
  assert.equal(parsed.claudeAiOauth.accessToken, "«redacted»");
  // structure (array of two) preserved
  assert.equal(parsed.claudeAiOauth.scopes.length, 2);
});

test("whole-file-sensitive falls back to flat mask for non-JSON", () => {
  const { text } = redactText("not json at all", { wholeFileSensitive: true });
  assert.equal(text, "«redacted»");
});

test("leaves clean content untouched", () => {
  const input = '{"theme": "dark", "verbose": true}';
  const { text, redacted } = redactText(input);
  assert.equal(redacted, false);
  assert.equal(text, input);
});

test("isSensitiveKey matches common credential keys", () => {
  for (const k of ["password", "apiKey", "refresh_token", "clientSecret", "authorization"]) {
    assert.equal(isSensitiveKey(k), true, k);
  }
  assert.equal(isSensitiveKey("username"), false);
  assert.equal(isSensitiveKey("theme"), false);
});
