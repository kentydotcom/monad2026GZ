import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CHAIN_BYTES, payloadIssue, sharedValue, statusText } from "./chainSession.ts";

test("payload size rejects empty and oversized text", () => {
  assert.equal(payloadIssue(""), "empty");
  assert.equal(payloadIssue("synthetic"), null);
  assert.equal(payloadIssue("x".repeat(MAX_CHAIN_BYTES)), null);
  assert.equal(payloadIssue("x".repeat(MAX_CHAIN_BYTES + 1)), "too-large");
  assert.equal(payloadIssue("字".repeat(2000)), "too-large");
});

test("status stays a code and localizes at display time", () => {
  assert.equal(statusText("accepted", "en"), "Accepted");
  assert.equal(statusText("accepted", "zh"), "已接受");
  assert.notEqual(statusText("accepted", "en"), statusText("accepted", "zh"));
  assert.equal(statusText("rejected", "en", "missing-replica"), "Rejected · missing-replica");
  assert.equal(statusText(null, "en"), "Not observed");
});

test("one shared hash is shown once, and a mismatch is not hidden", () => {
  assert.equal(sharedValue(["abc", "abc", "abc"]), "abc");
  assert.equal(sharedValue(["abc", "def", "abc"]), "differs");
  assert.equal(sharedValue([null, null]), null);
});
