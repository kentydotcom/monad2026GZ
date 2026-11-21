/**
 * Monad anchor for a private-chain block.
 *
 * The seal stores keccak256 of a domain-separated text, under a record id
 * derived from a different domain. The private header hash is not reused.
 * A confirmed anchor means the seal read back matches. It is an execution
 * receipt, not finality, and not a claim that the body is gone everywhere.
 */
import { rename, mkdir, readFile, open } from "node:fs/promises";
import { dirname } from "node:path";
import { keccak256, toUtf8Bytes } from "ethers";
import type { PinReceipt, SealView } from "./chain.js";

export const ANCHOR_DOMAIN = "WYRVEL/private-anchor/v1";
export const RECORD_DOMAIN = "WYRVEL/private-record/v1";
export const ANCHOR_CHAIN = "wyrvel-private";

export type AnchorKind = "data" | "prune";

export type AnchorSpec = {
  index: number;
  kind: AnchorKind;
  headerHash: string;
  target: number | null;
  targetHeader: string | null;
};

export type AnchorView = {
  anchored: boolean;
  status: "pending" | "confirmed" | "failed";
  code: string;
  index: number;
  kind: AnchorKind;
  recordId: string;
  commitment: string;
  headerHash: string;
  target: number | null;
  targetHeader: string | null;
  txHash: string | null;
  explorer: string | null;
  monadscan: string | null;
  readback: "match" | "mismatch" | "unread";
  feeWei: string | null;
  gasLimit: string | null;
  effectiveGasPrice: string | null;
  receiptWaitMs: number | null;
};

type StoredAnchor = AnchorView;

export type AnchorChain = {
  canSign(): boolean;
  sealOf(recordId: string): Promise<SealView>;
  pin(recordId: string, commitment: string, onBroadcast?: (txHash: string) => Promise<void>): Promise<PinReceipt>;
  txState(txHash: string): Promise<"pending" | "mined" | "dropped">;
};

export function anchorPreimage(spec: AnchorSpec): string {
  return [
    ANCHOR_DOMAIN,
    `chain ${ANCHOR_CHAIN}`,
    `index ${spec.index}`,
    `kind ${spec.kind}`,
    `header ${spec.headerHash.toLowerCase()}`,
    `target ${spec.target === null ? "-" : spec.target}`,
    `targetHeader ${spec.targetHeader === null ? "-" : spec.targetHeader.toLowerCase()}`,
  ].join("\n");
}

export function recordPreimage(spec: AnchorSpec): string {
  return [
    RECORD_DOMAIN,
    `chain ${ANCHOR_CHAIN}`,
    `index ${spec.index}`,
    `kind ${spec.kind}`,
    `header ${spec.headerHash.toLowerCase()}`,
  ].join("\n");
}

export function anchorCommitment(spec: AnchorSpec): string {
  return keccak256(toUtf8Bytes(anchorPreimage(spec)));
}

export function anchorRecordId(spec: AnchorSpec): string {
  return keccak256(toUtf8Bytes(recordPreimage(spec)));
}

export class AnchorBook {
  private rows = new Map<string, StoredAnchor>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly chain: AnchorChain,
    private readonly vaultHas: (recordId: string) => boolean,
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as { anchors?: StoredAnchor[] };
      this.rows.clear();
      for (const row of parsed.anchors ?? []) {
        if (row?.recordId) this.rows.set(row.recordId.toLowerCase(), row);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /** Read receipts for pending pins. Does not send a transaction. */
  async reconcile(): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.status !== "pending" || !row.txHash) continue;
      try {
        const state = await this.chain.txState(row.txHash);
        if (state === "pending") continue;
        if (state === "dropped") {
          row.status = "failed";
          row.code = "dropped";
          row.anchored = false;
          continue;
        }
        await this.applySeal(row);
      } catch {
        row.code = "rpc";
      }
    }
    await this.save();
  }

  async ensure(spec: AnchorSpec): Promise<AnchorView> {
    const run = this.tail.then(() => this.ensureLocked(spec));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async refresh(index: number): Promise<{ data: AnchorView | null; audit: AnchorView | null }> {
    const found = this.listFor(index);
    for (const row of [found.data, found.audit]) {
      if (!row) continue;
      try {
        const seal = await this.chain.sealOf(row.recordId);
        if (seal.pinned && seal.commitment.toLowerCase() === row.commitment.toLowerCase()) {
          row.status = "confirmed";
          row.readback = "match";
          row.anchored = true;
          row.code = "match";
        } else if (seal.pinned) {
          row.status = "failed";
          row.readback = "mismatch";
          row.anchored = false;
          row.code = "mismatch";
        }
      } catch {
        if (row.status !== "confirmed") row.code = "rpc";
      }
    }
    await this.save();
    return found;
  }

  listFor(index: number): { data: AnchorView | null; audit: AnchorView | null } {
    let data: AnchorView | null = null;
    let audit: AnchorView | null = null;
    for (const row of this.rows.values()) {
      if (row.kind === "data" && row.index === index) data = row;
      if (row.kind === "prune" && row.target === index) audit = row;
    }
    return { data, audit };
  }

  private async ensureLocked(spec: AnchorSpec): Promise<AnchorView> {
    const recordId = anchorRecordId(spec);
    const commitment = anchorCommitment(spec);
    if (commitment.toLowerCase() === spec.headerHash.toLowerCase()) {
      return this.fail(spec, recordId, commitment, "raw-hash");
    }
    if (this.vaultHas(recordId)) return this.fail(spec, recordId, commitment, "legacy-collision");
    let seal: SealView;
    try {
      seal = await this.chain.sealOf(recordId);
    } catch {
      return this.fail(spec, recordId, commitment, "rpc");
    }
    if (seal.pinned) {
      if (seal.commitment.toLowerCase() === commitment.toLowerCase()) return this.confirm(spec, recordId, commitment, null, "match");
      return this.fail(spec, recordId, commitment, "mismatch");
    }
    const existing = this.rows.get(recordId.toLowerCase());
    if (existing?.status === "pending" && existing.txHash) {
      try {
        const state = await this.chain.txState(existing.txHash);
        if (state === "pending") return { ...existing, anchored: false };
        if (state === "mined") {
          const view = await this.applySeal(existing);
          await this.save();
          return view;
        }
      } catch {
        return { ...existing, anchored: false, code: "rpc" };
      }
    }
    if (existing?.status === "confirmed" && existing.readback === "match") return { ...existing, anchored: true };
    if (!this.chain.canSign()) return this.fail(spec, recordId, commitment, "no-signer");
    try {
      const pin = await this.chain.pin(recordId, commitment, async (txHash) => {
        this.rows.set(recordId.toLowerCase(), this.base(spec, recordId, commitment, "pending", "broadcast", txHash));
        await this.save();
      });
      const again = await this.chain.sealOf(recordId);
      if (!again.pinned || again.commitment.toLowerCase() !== commitment.toLowerCase()) {
        return this.fail(spec, recordId, commitment, "mismatch", pin.txHash);
      }
      const view = this.fromPin(spec, recordId, commitment, pin);
      this.rows.set(recordId.toLowerCase(), view);
      await this.save();
      return view;
    } catch {
      const prior = this.rows.get(recordId.toLowerCase());
      if (prior?.status === "pending" && prior.txHash) return { ...prior, anchored: false };
      return this.fail(spec, recordId, commitment, "send-failed");
    }
  }

  private async applySeal(row: StoredAnchor): Promise<AnchorView> {
    const seal = await this.chain.sealOf(row.recordId);
    if (seal.pinned && seal.commitment.toLowerCase() === row.commitment.toLowerCase()) {
      const next = { ...row, status: "confirmed" as const, code: "match", readback: "match" as const, anchored: true };
      this.rows.set(row.recordId.toLowerCase(), next);
      return next;
    }
    const next = { ...row, status: "failed" as const, code: "mismatch", readback: "mismatch" as const, anchored: false };
    this.rows.set(row.recordId.toLowerCase(), next);
    return next;
  }

  private async confirm(spec: AnchorSpec, recordId: string, commitment: string, txHash: string | null, code: string): Promise<AnchorView> {
    const prior = this.rows.get(recordId.toLowerCase());
    const view: AnchorView = {
      ...this.base(spec, recordId, commitment, "confirmed", code, txHash ?? prior?.txHash ?? null),
      anchored: true,
      readback: "match",
      explorer: prior?.explorer ?? null,
      monadscan: prior?.monadscan ?? null,
      feeWei: prior?.feeWei ?? null,
      gasLimit: prior?.gasLimit ?? null,
      effectiveGasPrice: prior?.effectiveGasPrice ?? null,
      receiptWaitMs: prior?.receiptWaitMs ?? null,
    };
    this.rows.set(recordId.toLowerCase(), view);
    await this.save();
    return view;
  }

  private async fail(spec: AnchorSpec, recordId: string, commitment: string, code: string, txHash: string | null = null): Promise<AnchorView> {
    const view = this.base(spec, recordId, commitment, "failed", code, txHash);
    view.readback = code === "mismatch" ? "mismatch" : "unread";
    this.rows.set(recordId.toLowerCase(), view);
    await this.save();
    return view;
  }

  private fromPin(spec: AnchorSpec, recordId: string, commitment: string, pin: PinReceipt): AnchorView {
    return {
      ...this.base(spec, recordId, commitment, "confirmed", "match", pin.txHash),
      anchored: true,
      readback: "match",
      explorer: pin.explorer,
      monadscan: pin.monadscan,
      feeWei: pin.feeWei,
      gasLimit: pin.gasLimit,
      effectiveGasPrice: pin.effectiveGasPrice,
      receiptWaitMs: pin.receiptWaitMs,
    };
  }

  private base(
    spec: AnchorSpec,
    recordId: string,
    commitment: string,
    status: AnchorView["status"],
    code: string,
    txHash: string | null,
  ): AnchorView {
    return {
      anchored: false,
      status,
      code,
      index: spec.index,
      kind: spec.kind,
      recordId,
      commitment,
      headerHash: spec.headerHash,
      target: spec.target,
      targetHeader: spec.targetHeader,
      txHash,
      explorer: null,
      monadscan: null,
      readback: "unread",
      feeWei: null,
      gasLimit: null,
      effectiveGasPrice: null,
      receiptWaitMs: null,
    };
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ v: 1, anchors: [...this.rows.values()] }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.filePath);
  }
}
