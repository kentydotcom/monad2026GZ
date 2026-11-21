export const SAMPLE_NOTE =
  "SYNTHETIC retention note. Not a real person. Fictional post: Archive clerk. Candidate: Example Q. Sample. Staff id: EX-0000.";

export type SideKind = "unknown" | "match" | "gone" | "mismatch" | "error";

export type Side = {
  kind: SideKind;
  recordId: string | null;
  commitment: string | null;
  pinnedAt: number | null;
  pinner: string | null;
  recoverable: boolean | null;
  matches: boolean | null;
  code: string | null;
};

export type ObservedCheck = {
  recordId: string;
  recoverable: boolean;
  matches: boolean | null;
  error?: string;
  txHash: string | null;
  explorer: string | null;
  monadscan: string | null;
  seal: { pinned: boolean; commitment: string; pinnedAt: number; pinner: string } | null;
};

export type ObservedCommit = {
  recordId: string;
  pin: {
    txHash: string;
    explorer: string | null;
    monadscan: string | null;
    gasUsed: string | null;
    gasLimit: string | null;
    effectiveGasPrice: string | null;
    feeWei: string | null;
    receiptWaitMs: number | null;
  };
};

export type Evidence = {
  recordId: string | null;
  txHash: string | null;
  explorer: string | null;
  monadscan: string | null;
  gasUsed: string | null;
  gasLimit: string | null;
  effectiveGasPrice: string | null;
  feeWei: string | null;
  receiptWaitMs: number | null;
  roundTripMs: number | null;
  before: Side;
  after: Side;
};

export function unknownSide(): Side {
  return {
    kind: "unknown",
    recordId: null,
    commitment: null,
    pinnedAt: null,
    pinner: null,
    recoverable: null,
    matches: null,
    code: null,
  };
}

export function freshEvidence(): Evidence {
  return {
    recordId: null,
    txHash: null,
    explorer: null,
    monadscan: null,
    gasUsed: null,
    gasLimit: null,
    effectiveGasPrice: null,
    feeWei: null,
    receiptWaitMs: null,
    roundTripMs: null,
    before: unknownSide(),
    after: unknownSide(),
  };
}

/** Monad fee is gas limit times price per gas, not receipt gasUsed. */
export function chargedFeeWei(gasLimit: string | null, priceWei: string | null): string | null {
  if (!gasLimit || !priceWei || !/^\d+$/.test(gasLimit) || !/^\d+$/.test(priceWei)) return null;
  return (BigInt(gasLimit) * BigInt(priceWei)).toString();
}

export function feeMon(feeWei: string | null): string | null {
  if (!feeWei || !/^\d+$/.test(feeWei)) return null;
  const wei = BigInt(feeWei);
  const scale = 10n ** 18n;
  const whole = wei / scale;
  const frac = (wei % scale).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return frac.length > 0 ? `${whole.toString()}.${frac}` : whole.toString();
}

export function gwei(wei: string | null): string | null {
  if (!wei || !/^\d+$/.test(wei)) return null;
  const value = BigInt(wei);
  const whole = value / 1_000_000_000n;
  const frac = (value % 1_000_000_000n).toString().padStart(9, "0").slice(0, 3).replace(/0+$/, "");
  return frac.length > 0 ? `${whole.toString()}.${frac}` : whole.toString();
}

export function noteCommit(previous: Evidence, commit: ObservedCommit, roundTripMs: number | null): Evidence {
  return {
    ...freshEvidence(),
    recordId: commit.recordId,
    txHash: commit.pin.txHash,
    explorer: commit.pin.explorer,
    monadscan: commit.pin.monadscan,
    gasUsed: commit.pin.gasUsed,
    gasLimit: commit.pin.gasLimit,
    effectiveGasPrice: commit.pin.effectiveGasPrice,
    feeWei: commit.pin.feeWei,
    receiptWaitMs: commit.pin.receiptWaitMs,
    roundTripMs,
  };
}

export function noteCheck(previous: Evidence, check: ObservedCheck): Evidence {
  const side = classify(check);
  const next: Evidence = {
    ...previous,
    txHash: check.txHash ?? previous.txHash,
    explorer: check.explorer ?? previous.explorer,
    monadscan: check.monadscan ?? previous.monadscan,
  };
  if (side.kind === "match") {
    const same = sameId(previous.recordId, check.recordId);
    return { ...next, recordId: check.recordId, before: side, after: same ? previous.after : unknownSide() };
  }
  if (side.kind === "gone") {
    if (previous.before.kind !== "match" || !sameId(previous.before.recordId, check.recordId)) {
      return { ...next, after: { ...side, kind: "error", code: "unpaired" } };
    }
    if (!sameSeal(previous.before, side)) {
      return { ...next, after: { ...side, kind: "mismatch", code: "seal-differs" } };
    }
    return { ...next, recordId: check.recordId, after: side };
  }
  if (check.recoverable) return { ...next, before: side };
  return { ...next, after: side };
}

function classify(check: ObservedCheck): Side {
  const base: Side = {
    kind: "error",
    recordId: check.recordId,
    commitment: check.seal?.commitment ?? null,
    pinnedAt: check.seal?.pinnedAt ?? null,
    pinner: check.seal?.pinner ?? null,
    recoverable: check.recoverable,
    matches: check.matches,
    code: null,
  };
  if (check.error && !check.seal) return { ...base, kind: "error", code: "chain-unread" };
  if (check.recoverable && check.matches === true && check.seal?.pinned) return { ...base, kind: "match", code: null };
  if (check.recoverable && check.matches === false) return { ...base, kind: "mismatch", code: "hash-mismatch" };
  if (check.recoverable) return { ...base, kind: "mismatch", code: "still-there" };
  if (!check.recoverable && check.seal?.pinned) return { ...base, kind: "gone", code: null };
  if (!check.recoverable) return { ...base, kind: "error", code: "chain-unread" };
  return { ...base, kind: "error", code: "chain-unread" };
}

function sameId(left: string | null, right: string | null): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function sameSeal(before: Side, after: Side): boolean {
  return Boolean(
    before.commitment &&
      after.commitment &&
      before.commitment.toLowerCase() === after.commitment.toLowerCase() &&
      before.pinnedAt === after.pinnedAt &&
      before.pinner &&
      after.pinner &&
      before.pinner.toLowerCase() === after.pinner.toLowerCase(),
  );
}
