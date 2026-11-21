import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  headerHash,
  memoryPeer,
  PrivateNode,
  replicate,
  sha256Hex,
  signHeader,
  startCluster,
  type ChainResult,
  type Envelope,
  type Header,
  type Peer,
} from "../src/privatechain.js";

const PAYLOAD = "SYNTHETIC private-chain note. Not a real person. Staff id EX-0000.";

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return [path];
    }),
  );
  return nested.flat();
}

async function holds(dir: string, needle: string): Promise<boolean> {
  const files = await walk(dir);
  const raw = Buffer.from(needle);
  for (const file of files) {
    const buf = await readFile(file);
    if (buf.includes(raw)) return true;
  }
  return false;
}

async function trio(logs: string[]) {
  const root = await mkdtemp(join(tmpdir(), "wyrvel-chain-"));
  await mkdir(join(root, "payloads"), { recursive: true });
  const keep = "vault-record-must-stay";
  await writeFile(join(root, "index.json"), `{"keep":"${keep}"}`);
  await writeFile(join(root, "payloads", "keep"), keep);
  const log = (entry: Record<string, string | number | boolean | null>) => {
    logs.push(JSON.stringify(entry));
  };
  const chain = join(root, "chain");
  const { ensureLayout } = await import("../src/privatechain.js");
  await ensureLayout(chain);
  const membership = join(chain, "membership.json");
  const leader = await PrivateNode.open(join(chain, "nodes", "leader"), membership, "leader", log);
  const a = await PrivateNode.open(join(chain, "nodes", "replica-a"), membership, "replica-a", log);
  const b = await PrivateNode.open(join(chain, "nodes", "replica-b"), membership, "replica-b", log);
  await a.importSync((await leader.exportChain()).blocks);
  await b.importSync((await leader.exportChain()).blocks);
  return { root, chain, membership, leader, a, b, keep };
}

function deadPeer(): Peer {
  return {
    id: "replica-b",
    propose: async () => {
      throw new Error("down");
    },
    commit: async () => {
      throw new Error("down");
    },
    abort: async () => ({ ok: true, code: "aborted" }),
  };
}

test("append links headers and keeps the payload on every replica", async () => {
  const logs: string[] = [];
  const { root, leader, a, b } = await trio(logs);
  const result = await replicate(leader, [memoryPeer(a), memoryPeer(b)], () => leader.stageData(Buffer.from(PAYLOAD)));
  assert.equal(result.status, "accepted");
  assert.equal(result.index, 1);
  const exported = await leader.exportChain();
  const genesis = exported.blocks[0];
  const data = exported.blocks[1];
  assert.ok(genesis && data);
  assert.equal(data.header.prev, headerHash(genesis.header));
  assert.equal(data.header.body, sha256Hex(Buffer.from(PAYLOAD)));
  for (const node of [leader, a, b]) {
    const view = await node.observe(1);
    assert.equal(view.code, "present");
    assert.equal(view.payload, PAYLOAD);
    assert.equal(view.headerHash, result.hash);
  }
  assert.equal((await leader.auditTarget(1)).found, false);
  assert.equal(logs.some((line) => line.includes(PAYLOAD)), false);
  assert.equal(await holds(join(root, "chain"), PAYLOAD), true);
  await rm(root, { recursive: true, force: true });
});

test("authorized prune removes active bodies and leaves the header hash", async () => {
  const { root, leader, a, b } = await trio([]);
  const appended = await replicate(leader, [memoryPeer(a), memoryPeer(b)], () => leader.stageData(Buffer.from(PAYLOAD)));
  const before = await leader.observe(1);
  const pruned = await replicate(leader, [memoryPeer(a), memoryPeer(b)], () => leader.stagePrune(1));
  assert.equal(pruned.status, "accepted");
  assert.equal(pruned.index, 2);
  const afterExport = await leader.exportChain();
  const data = afterExport.blocks[1];
  const audit = afterExport.blocks[2];
  assert.ok(data && audit);
  assert.equal(data.header.body, before.bodyCommitment);
  assert.equal(headerHash(data.header), before.headerHash);
  assert.equal(audit.header.kind, "prune");
  assert.equal(audit.header.target, 1);
  assert.equal(audit.header.prev, before.headerHash);
  for (const node of [leader, a, b]) {
    const view = await node.observe(1);
    assert.equal(view.payload, null);
    assert.equal(view.payloadPresent, false);
    assert.equal(view.code, "pruned");
    assert.equal(view.headerHash, before.headerHash);
    assert.equal(view.bodyCommitment, before.bodyCommitment);
  }
  assert.equal(await holds(join(root, "chain"), PAYLOAD), false);
  const record = await leader.auditTarget(1);
  assert.equal(record.found, true);
  assert.equal(record.height, 2);
  assert.equal(record.index, 2);
  assert.equal(record.target, 1);
  assert.equal(record.authorized, true);
  assert.equal(record.links, true);
  assert.equal(record.code, "audit");
  assert.equal(record.hash, headerHash(audit.header));
  assert.equal(record.targetHeader, before.headerHash);
  assert.equal(record.prev, before.headerHash);
  assert.notEqual(record.hash, before.headerHash);
  assert.equal(JSON.stringify(record).includes(PAYLOAD), false);
  assert.equal((await leader.auditTarget(9)).found, false);
  const vault = await readFile(join(root, "index.json"), "utf8");
  assert.match(vault, /vault-record-must-stay/);
  await rm(root, { recursive: true, force: true });
});

test("an unauthorized signature does not remove the body", async () => {
  const { root, chain, leader, a, b } = await trio([]);
  await replicate(leader, [memoryPeer(a), memoryPeer(b)], () => leader.stageData(Buffer.from(PAYLOAD)));
  const key = JSON.parse(await readFile(join(chain, "nodes", "replica-a", "key.json"), "utf8")) as { privateKeyPem: string };
  const header: Header = {
    v: 1,
    index: 2,
    prev: headerHash((await leader.exportChain()).blocks[1]!.header),
    kind: "prune",
    body: "00",
    target: 1,
    signer: "replica-a",
  };
  const envelope: Envelope = { header, signature: signHeader(key.privateKeyPem, header), payloadB64: null };
  const ack = await a.acceptRemote(envelope);
  assert.equal(ack.ok, false);
  assert.equal(ack.code, "unauthorized");
  assert.equal((await a.observe(1)).payload, PAYLOAD);
  assert.equal(a.height(), 1);
  await rm(root, { recursive: true, force: true });
});

test("a tampered body is rejected and a replay does not append twice", async () => {
  const { root, leader, a, b } = await trio([]);
  const payload = Buffer.from(PAYLOAD);
  const staged = await leader.stageData(payload);
  const tampered: Envelope = {
    ...staged,
    payloadB64: Buffer.from(`${PAYLOAD} tampered`).toString("base64"),
  };
  const bad = await a.acceptRemote(tampered);
  assert.equal(bad.code, "tamper");
  await leader.abort();
  const result = await replicate(leader, [memoryPeer(a), memoryPeer(b)], () => leader.stageData(payload));
  assert.equal(result.status, "accepted");
  const exported = await a.exportChain();
  const block = exported.blocks[1];
  assert.ok(block);
  const replay = await a.acceptRemote({
    header: block.header,
    signature: block.signature,
    payloadB64: block.payloadB64,
  });
  assert.equal(replay.code, "already");
  assert.equal(a.height(), 1);
  assert.equal((await leader.exportChain()).blocks.length, 2);
  await rm(root, { recursive: true, force: true });
});

test("a missing replica rejects the append and leaves no new body", async () => {
  const { root, leader, a } = await trio([]);
  const before = leader.height();
  const result = await replicate(leader, [memoryPeer(a), deadPeer()], () => leader.stageData(Buffer.from(PAYLOAD)));
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "missing-replica");
  assert.equal(leader.height(), before);
  assert.equal(a.height(), before);
  assert.equal(await holds(join(root, "chain"), PAYLOAD), false);
  const again = await leader.observe(1);
  assert.notEqual(again.code, "present");
  await rm(root, { recursive: true, force: true });
});

test("a restarted replica applies the prune before it serves the old payload", async () => {
  const { root, chain, membership, leader, a, b } = await trio([]);
  await replicate(leader, [memoryPeer(a), memoryPeer(b)], () => leader.stageData(Buffer.from(PAYLOAD)));
  const bDir = join(chain, "nodes", "replica-b");
  const snap = join(root, "snap-b");
  await cp(bDir, snap, { recursive: true });
  const pruned = await replicate(leader, [memoryPeer(a), memoryPeer(b)], () => leader.stagePrune(1));
  assert.equal(pruned.status, "accepted");
  await rm(bDir, { recursive: true, force: true });
  await cp(snap, bDir, { recursive: true });
  const logs: string[] = [];
  const restarted = await PrivateNode.open(bDir, membership, "replica-b", (entry) => logs.push(JSON.stringify(entry)));
  assert.equal(restarted.ready, false);
  const closed = await restarted.observe(1);
  assert.equal(closed.payload, null);
  assert.equal(closed.code, "fail-closed");
  assert.equal(JSON.stringify(closed).includes(PAYLOAD), false);
  await restarted.importSync((await leader.exportChain()).blocks);
  const view = await restarted.observe(1);
  assert.equal(view.ready, true);
  assert.equal(view.code, "pruned");
  assert.equal(view.payload, null);
  assert.equal(view.headerHash, (await leader.observe(1)).headerHash);
  assert.equal(await holds(bDir, PAYLOAD), false);
  assert.equal(logs.some((line) => line.includes(PAYLOAD)), false);
  await rm(root, { recursive: true, force: true });
});

test("three processes accept a block and a prune", async () => {
  const root = await mkdtemp(join(tmpdir(), "wyrvel-procs-"));
  const cluster = await startCluster(root);
  try {
    const topology = await cluster.topology();
    assert.equal(topology.bft, false);
    assert.equal(topology.failureDomain, "single-host-process-simulation");
    assert.equal(topology.mechanism, "block-body-pruning");
    const appended = (await cluster.append(PAYLOAD)) as ChainResult;
    assert.equal(appended.status, "accepted");
    const before = (await cluster.observe(appended.index ?? -1)) as { nodes: Array<{ code: string; payload: string | null; headerHash: string }> };
    assert.equal(before.nodes.length, 3);
    assert.equal(before.nodes.every((node) => node.code === "present" && node.payload === PAYLOAD), true);
    const header = before.nodes[0]?.headerHash;
    const pruned = await cluster.prune(appended.index ?? -1);
    assert.equal(pruned.status, "accepted");
    const after = (await cluster.observe(appended.index ?? -1)) as {
      nodes: Array<{ code: string; payload: string | null; headerHash: string | null; bodyCommitment: string | null }>;
    };
    assert.equal(after.nodes.every((node) => node.code === "pruned" && node.payload === null && node.headerHash === header), true);
    assert.equal(JSON.stringify(after).includes(PAYLOAD), false);
    const audit = (await cluster.audit(appended.index ?? -1)) as {
      leader: { found: boolean; height: number; index: number; hash: string; authorized: boolean; links: boolean; code: string };
    };
    assert.equal(audit.leader.found, true);
    assert.equal(audit.leader.height, 2);
    assert.equal(audit.leader.index, 2);
    assert.equal(audit.leader.authorized, true);
    assert.equal(audit.leader.links, true);
    assert.equal(audit.leader.code, "audit");
    assert.equal(JSON.stringify(audit).includes(PAYLOAD), false);
  } finally {
    await cluster.stop();
    await rm(root, { recursive: true, force: true });
  }
});
