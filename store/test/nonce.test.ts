import assert from "node:assert/strict";
import test from "node:test";
import { authorizeBasic, redactSecrets } from "../src/gate.js";
import { NonceBook, bufferedGas } from "../src/nonce.js";

test("nonce book uses the pending count once, then the next local value", async () => {
  const book = new NonceBook();
  let calls = 0;
  const fetchPending = async () => {
    calls += 1;
    return 7;
  };
  assert.equal(await book.take(fetchPending), 7);
  assert.equal(await book.take(fetchPending), 8);
  assert.equal(calls, 1);
  book.reset();
  assert.equal(await book.take(fetchPending), 7);
  assert.equal(calls, 2);
});

test("gas buffer is applied and the floor is respected", () => {
  assert.equal(bufferedGas(1000n, 500n), 11200n);
  assert.equal(bufferedGas(100n, 50_000n), 50_000n);
  assert.throws(() => bufferedGas(0n, 1n));
});

test("gate accepts only the kent user and the injected password", () => {
  const header = `Basic ${Buffer.from("kent:unit-test-password").toString("base64")}`;
  assert.equal(authorizeBasic(header, "unit-test-password"), true);
  assert.equal(authorizeBasic(header, "other-password"), false);
  assert.equal(
    authorizeBasic(`Basic ${Buffer.from("someone:unit-test-password").toString("base64")}`, "unit-test-password"),
    false,
  );
  assert.equal(authorizeBasic(undefined, "unit-test-password"), false);
});

test("redaction removes a signing key from an error string", () => {
  const key = "0x" + "ab".repeat(32);
  const text = redactSecrets(`signer ${key} failed`, [key]);
  assert.equal(text.includes(key), false);
  assert.equal(text.includes("ab".repeat(32)), false);
});
