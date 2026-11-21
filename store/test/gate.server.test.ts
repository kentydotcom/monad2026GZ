import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Chain } from "../src/chain.js";
import { startServer } from "../src/server.js";
import { Service } from "../src/service.js";
import { Vault } from "../src/vault.js";

test("the password gate locks the tour and leaves health open", async () => {
  const root = await mkdtemp(join(tmpdir(), "wyrvel-gate-"));
  const vault = new Vault(root);
  await vault.load();
  const chain = new Chain("", null, null);
  const service = new Service(vault, chain);
  const password = "unit-test-password";
  const server = await startServer({
    service,
    host: "127.0.0.1",
    port: 0,
    staticDir: null,
    localAdmin: false,
    gatePassword: password,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const health = await fetch(`${base}/v1/health`);
    assert.equal(health.status, 200);
    const locked = await fetch(`${base}/v1/meta`);
    assert.equal(locked.status, 401);
    const wrong = await fetch(`${base}/v1/meta`, {
      headers: { authorization: `Basic ${Buffer.from("ada:unit-test-password").toString("base64")}` },
    });
    assert.equal(wrong.status, 401);
    const open = await fetch(`${base}/v1/meta`, {
      headers: { authorization: `Basic ${Buffer.from(`kent:${password}`).toString("base64")}` },
    });
    assert.equal(open.status, 200);
    const chainLocked = await fetch(`${base}/v1/pchain/topology`);
    assert.equal(chainLocked.status, 401);
    const chainOff = await fetch(`${base}/v1/pchain/topology`, {
      headers: { authorization: `Basic ${Buffer.from(`kent:${password}`).toString("base64")}` },
    });
    assert.equal(chainOff.status, 503);
  } finally {
    await server.close();
  }
});
