import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ANCHOR_DOMAIN,
  AnchorBook,
  RECORD_DOMAIN,
  anchorCommitment,
  anchorPreimage,
  anchorRecordId,
  recordPreimage,
  type AnchorChain,
  type AnchorSpec,
} from "../src/anchor.js";
import type { PinReceipt, SealView } from "../src/chain.js";

const HEADER = `ab${"cd".repeat(31)}`.slice(0, 64);
const SPEC: AnchorSpec = { index: 1, kind: "data", headerHash: HEADER, target: null, targetHeader: null };

function receipt(txHash: string): PinReceipt {
  return {
    txHash,
    blockNumber: 1,
    pinnedAt: 1,
    pinner: `0x${"11".repeat(20)}`,
    chainId: 31337,
    explorer: null,
    monadscan: null,
    gasUsed: "10",
    gasLimit: "300000",
    effectiveGasPrice: "100000000000",
    feeWei: (300000n * 100000000000n).toString(),
    receiptWaitMs: 5,
  };
}

function world(partial: Partial<{ sealFail: boolean; sendFail: boolean; canSign: boolean; tx: "pending" | "mined" | "dropped"; mismatch: boolean }> = {}) {
  const seals = new Map<string, SealView>();
  let pins = 0;
  const chain: AnchorChain = {
    canSign: () => partial.canSign !== false,
    async sealOf(id) {
      if (partial.sealFail) throw new Error("rpc down");
      return (
        seals.get(id) ?? {
          pinned: false,
          commitment: `0x${"00".repeat(32)}`,
          pinnedAt: 0,
          pinner: `0x${"00".repeat(20)}`,
        }
      );
    },
    async pin(id, commitment, onBroadcast) {
      pins += 1;
      const tx = `0x${pins.toString(16).padStart(64, "0")}`;
      if (onBroadcast) await onBroadcast(tx);
      if (partial.sendFail) throw new Error("rpc down");
      seals.set(id, {
        pinned: !partial.mismatch,
        commitment: partial.mismatch ? `0x${"ff".repeat(32)}` : commitment,
        pinnedAt: 1,
        pinner: `0x${"11".repeat(20)}`,
      });
      if (partial.mismatch) {
        seals.set(id, { ...seals.get(id)!, pinned: true });
      }
      return receipt(tx);
    },
    async txState() {
      return partial.tx ?? "mined";
    },
  };
  return { chain, seals, pins: () => pins };
}

test("the pinned commitment is domain-separated from the header hash and the record id", () => {
  const preimage = anchorPreimage(SPEC);
  assert.match(preimage, new RegExp(ANCHOR_DOMAIN));
  assert.match(preimage, /kind data/);
  assert.match(preimage, new RegExp(HEADER));
  assert.match(recordPreimage(SPEC), new RegExp(RECORD_DOMAIN));
  const commitment = anchorCommitment(SPEC);
  const recordId = anchorRecordId(SPEC);
  assert.notEqual(commitment, recordId);
  assert.notEqual(commitment, `0x${HEADER}`);
  assert.notEqual(recordId, `0x${HEADER}`);
  const prune = anchorCommitment({ ...SPEC, index: 2, kind: "prune", target: 1, targetHeader: HEADER });
  assert.notEqual(prune, commitment);
});

test("a matching seal is not pinned again", async () => {
  const root = await mkdtemp(join(tmpdir(), "wyrvel-anchor-"));
  const { chain, seals, pins } = world();
  const id = anchorRecordId(SPEC);
  seals.set(id, {
    pinned: true,
    commitment: anchorCommitment(SPEC),
    pinnedAt: 9,
    pinner: `0x${"11".repeat(20)}`,
  });
  const book = new AnchorBook(join(root, "chain", "anchors.json"), chain, () => false);
  await book.load();
  const view = await book.ensure(SPEC);
  assert.equal(view.anchored, true);
  assert.equal(view.readback, "match");
  assert.equal(pins(), 0);
});

test("a readback mismatch does not count as anchored and does not send", async () => {
  const root = await mkdtemp(join(tmpdir(), "wyrvel-anchor-"));
  const { chain, seals, pins } = world();
  seals.set(anchorRecordId(SPEC), {
    pinned: true,
    commitment: `0x${"ff".repeat(32)}`,
    pinnedAt: 1,
    pinner: `0x${"11".repeat(20)}`,
  });
  const book = new AnchorBook(join(root, "chain", "anchors.json"), chain, () => false);
  await book.load();
  const view = await book.ensure(SPEC);
  assert.equal(view.anchored, false);
  assert.equal(view.status, "failed");
  assert.equal(view.readback, "mismatch");
  assert.equal(pins(), 0);
});

test("an RPC failure is not an anchor", async () => {
  const root = await mkdtemp(join(tmpdir(), "wyrvel-anchor-"));
  const { chain, pins } = world({ sealFail: true });
  const book = new AnchorBook(join(root, "chain", "anchors.json"), chain, () => false);
  await book.load();
  const view = await book.ensure(SPEC);
  assert.equal(view.anchored, false);
  assert.equal(view.code, "rpc");
  assert.equal(pins(), 0);
});

test("a pending transaction is not sent twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "wyrvel-anchor-"));
  const { chain, pins } = world({ sendFail: true, tx: "pending" });
  const book = new AnchorBook(join(root, "chain", "anchors.json"), chain, () => false);
  await book.load();
  const first = await book.ensure(SPEC);
  assert.equal(first.status, "pending");
  assert.equal(first.anchored, false);
  assert.equal(pins(), 1);
  const second = await book.ensure(SPEC);
  assert.equal(second.status, "pending");
  assert.equal(pins(), 1);
});

test("a confirmed anchor survives a restart and is not pinned again", async () => {
  const root = await mkdtemp(join(tmpdir(), "wyrvel-anchor-"));
  const path = join(root, "chain", "anchors.json");
  const firstWorld = world();
  const book = new AnchorBook(path, firstWorld.chain, () => false);
  await book.load();
  const view = await book.ensure(SPEC);
  assert.equal(view.anchored, true);
  assert.equal(view.feeWei, (300000n * 100000000000n).toString());
  const again = world();
  again.seals.set(view.recordId, {
    pinned: true,
    commitment: view.commitment,
    pinnedAt: 1,
    pinner: `0x${"11".repeat(20)}`,
  });
  const reloaded = new AnchorBook(path, again.chain, () => false);
  await reloaded.load();
  await reloaded.reconcile();
  const second = await reloaded.ensure(SPEC);
  assert.equal(second.anchored, true);
  assert.equal(second.txHash, view.txHash);
  assert.equal(again.pins(), 0);
});

test("two overlapping anchors send one transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "wyrvel-anchor-"));
  const { chain, pins } = world();
  const book = new AnchorBook(join(root, "chain", "anchors.json"), chain, () => false);
  await book.load();
  const [a, b] = await Promise.all([book.ensure(SPEC), book.ensure(SPEC)]);
  assert.equal(a.anchored && b.anchored, true);
  assert.equal(pins(), 1);
});

test("a legacy record id collision is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "wyrvel-anchor-"));
  const { chain, pins } = world();
  const book = new AnchorBook(join(root, "chain", "anchors.json"), chain, () => true);
  await book.load();
  const view = await book.ensure(SPEC);
  assert.equal(view.code, "legacy-collision");
  assert.equal(view.anchored, false);
  assert.equal(pins(), 0);
});
