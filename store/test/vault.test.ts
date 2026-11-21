import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitmentOf } from "../src/hash.js";
import { Vault } from "../src/vault.js";

const PAYLOAD = "WYRVEL keeps this sentence private until erase.";

test("erase removes the payload bytes from the store directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "wyrvel-vault-"));
  const vault = new Vault(root);
  await vault.load();

  const meta = await vault.put(PAYLOAD);
  assert.equal(meta.commitment, commitmentOf(PAYLOAD));

  const before = await vault.read(meta.recordId);
  assert.equal(before.recoverable, true);
  assert.equal(before.payload, PAYLOAD);

  const filesBefore = await walk(root);
  const held = await Promise.all(filesBefore.map(async (file) => readFile(file)));
  assert.ok(held.some((buf) => buf.includes(Buffer.from(PAYLOAD))));

  const erased = await vault.erase(meta.recordId);
  assert.ok(erased.erasedAt);

  const after = await vault.read(meta.recordId);
  assert.equal(after.recoverable, false);
  assert.equal(after.payload, null);

  const filesAfter = await walk(root);
  const contents = await Promise.all(filesAfter.map(async (file) => readFile(file)));
  assert.ok(contents.every((buf) => !buf.includes(Buffer.from(PAYLOAD))));
  assert.ok(filesAfter.every((file) => !file.includes(meta.recordId.slice(2).toLowerCase())));
});

test("a second erase stays unrecoverable", async () => {
  const root = await mkdtemp(join(tmpdir(), "wyrvel-vault-"));
  const vault = new Vault(root);
  await vault.load();
  const meta = await vault.put("second pass");
  await vault.erase(meta.recordId);
  const again = await vault.erase(meta.recordId);
  assert.equal((await vault.read(meta.recordId)).recoverable, false);
  assert.ok(again.erasedAt);
});

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return [path];
    }),
  );
  return files.flat();
}
