import assert from "node:assert/strict";
import test from "node:test";
import { copy } from "./i18n.ts";
import {
  SAMPLE_NOTE,
  chargedFeeWei,
  feeMon,
  freshEvidence,
  gwei,
  noteCheck,
  noteCommit,
  type ObservedCheck,
} from "./evidence.ts";

const SEAL = {
  pinned: true,
  commitment: "0x" + "ab".repeat(32),
  pinnedAt: 1_700_000_000,
  pinner: "0xD3Cea1317b62cB5C0CDe7e8a98cD80bBA2DC671e",
};

const RECORD = "0x" + "11".repeat(32);

function check(partial: Partial<ObservedCheck>): ObservedCheck {
  return {
    recordId: RECORD,
    recoverable: false,
    matches: null,
    txHash: "0x" + "22".repeat(32),
    explorer: null,
    monadscan: null,
    seal: SEAL,
    ...partial,
  };
}

test("before is a real match and after stays unknown", () => {
  const next = noteCheck(freshEvidence(), check({ recoverable: true, matches: true }));
  assert.equal(next.before.kind, "match");
  assert.equal(next.after.kind, "unknown");
  assert.equal(next.before.commitment, SEAL.commitment);
});

test("after requires a failed read and the same seal", () => {
  const before = noteCheck(freshEvidence(), check({ recoverable: true, matches: true }));
  const after = noteCheck(before, check({ recoverable: false, matches: null }));
  assert.equal(after.before.kind, "match");
  assert.equal(after.after.kind, "gone");
  assert.equal(after.after.commitment, after.before.commitment);
  assert.equal(after.after.pinnedAt, after.before.pinnedAt);
  assert.equal(after.after.pinner, after.before.pinner);
});

test("a different seal is not a pass", () => {
  const before = noteCheck(freshEvidence(), check({ recoverable: true, matches: true }));
  const after = noteCheck(
    before,
    check({
      recoverable: false,
      seal: { ...SEAL, commitment: "0x" + "cd".repeat(32) },
    }),
  );
  assert.equal(after.after.kind, "mismatch");
  assert.equal(after.after.code, "seal-differs");
});

test("a read failure without a prior match is not an after pass", () => {
  const next = noteCheck(freshEvidence(), check({ recoverable: false }));
  assert.equal(next.before.kind, "unknown");
  assert.equal(next.after.kind, "error");
  assert.equal(next.after.code, "unpaired");
});

test("a hash mismatch does not count as the before snapshot", () => {
  const next = noteCheck(freshEvidence(), check({ recoverable: true, matches: false }));
  assert.equal(next.before.kind, "mismatch");
  assert.equal(next.before.code, "hash-mismatch");
  assert.notEqual(next.before.kind, "match");
});

test("a chain error does not become a pass", () => {
  const next = noteCheck(
    freshEvidence(),
    check({ recoverable: true, matches: null, seal: null, error: "Monad RPC timed out." }),
  );
  assert.equal(next.before.kind, "error");
  assert.equal(next.before.code, "chain-unread");
});

test("a new matching record clears the previous after snapshot", () => {
  const first = noteCheck(freshEvidence(), check({ recoverable: true, matches: true }));
  const gone = noteCheck(first, check({ recoverable: false }));
  const other = "0x" + "33".repeat(32);
  const again = noteCheck(gone, check({ recordId: other, recoverable: true, matches: true }));
  assert.equal(again.before.recordId, other);
  assert.equal(again.after.kind, "unknown");
});

test("commit resets observations and keeps measured fee fields", () => {
  const seen = noteCheck(freshEvidence(), check({ recoverable: true, matches: true }));
  const next = noteCommit(
    seen,
    {
      recordId: RECORD,
      pin: {
        txHash: "0x" + "44".repeat(32),
        explorer: "https://testnet.monadvision.com/tx/" + "44".repeat(32),
        monadscan: null,
        gasUsed: "21000",
        gasLimit: "300000",
        effectiveGasPrice: "102000000000",
        feeWei: "30600000000000000",
        receiptWaitMs: 420,
      },
    },
    510,
  );
  assert.equal(next.before.kind, "unknown");
  assert.equal(next.after.kind, "unknown");
  assert.equal(next.receiptWaitMs, 420);
  assert.equal(next.roundTripMs, 510);
  assert.equal(next.gasLimit, "300000");
  assert.equal(feeMon(next.feeWei), "0.0306");
  assert.equal(gwei(next.effectiveGasPrice), "102");
  assert.equal(chargedFeeWei("300000", "102000000000"), "30600000000000000");
  assert.notEqual(chargedFeeWei(next.gasUsed, next.effectiveGasPrice), next.feeWei);
});

test("sample note is synthetic and locales state the limit", () => {
  assert.match(SAMPLE_NOTE, /SYNTHETIC/);
  assert.equal(SAMPLE_NOTE.includes("@"), false);
  assert.match(copy.en.limit, /not a global/i);
  assert.match(copy.zh.limit, /团队存储/);
  assert.equal(copy.en.limit.includes("Proof of Deletion"), false);
  assert.equal(copy.zh.limit.includes("全局删除"), false);
  assert.match(copy.zh.scenario, /合成/);
  assert.match(copy.en.whyMonadLine, /not only Monad|other chains/i);
});
