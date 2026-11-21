import { commitmentOf, isRecordId } from "./hash.js";
import { Chain, errorText, type PinReceipt, type SealView } from "./chain.js";
import { Vault, type RecordMeta } from "./vault.js";

export type CommitResult = {
  ok: true;
  recordId: string;
  commitment: string;
  byteLength: number;
  storedAt: string;
  pin: PinReceipt;
};

export type CheckResult = {
  ok: boolean;
  recordId: string;
  recoverable: boolean;
  payload: string | null;
  seal: SealView | null;
  matches: boolean | null;
  txHash: string | null;
  explorer: string | null;
  monadscan: string | null;
  error?: string;
};

export type E2EState = {
  contract: string | null;
  deployTxHash: string | null;
  recordId: string | null;
  commitment: string | null;
  txHash: string | null;
  pinnedAt: number | null;
  pinner: string | null;
};

const E2E_PAYLOAD_PREFIX = "WYRVEL keeps this sentence private until erase.";

export class Service {
  private e2ePayload: string | null = null;

  e2e: E2EState = {
    contract: null,
    deployTxHash: null,
    recordId: null,
    commitment: null,
    txHash: null,
    pinnedAt: null,
    pinner: null,
  };

  constructor(
    private readonly vault: Vault,
    readonly chain: Chain,
  ) {}

  async commitPayload(payload: string): Promise<CommitResult> {
    if (typeof payload !== "string" || payload.length === 0) {
      throw new Error("Payload is required.");
    }
    if (Buffer.byteLength(payload, "utf8") > 65_536) {
      throw new Error("Payload is too large.");
    }
    await this.chain.refresh();
    const meta = await this.vault.put(payload);
    try {
      const pin = await this.chain.pin(meta.recordId, meta.commitment);
      await this.vault.attachPin(meta.recordId, {
        txHash: pin.txHash,
        blockNumber: pin.blockNumber,
        pinnedAt: pin.pinnedAt,
        pinner: pin.pinner,
      });
      return {
        ok: true,
        recordId: meta.recordId,
        commitment: meta.commitment,
        byteLength: meta.byteLength,
        storedAt: meta.storedAt,
        pin,
      };
    } catch (err) {
      await this.vault.drop(meta.recordId);
      throw new Error(errorText(err));
    }
  }

  async eraseRecord(recordId: string): Promise<RecordMeta> {
    return this.vault.erase(recordId);
  }

  async readRecord(recordId: string) {
    return this.vault.read(recordId);
  }

  async checkRecord(recordId: string): Promise<CheckResult> {
    if (!isRecordId(recordId)) {
      throw new Error("Record id must be a 32-byte hex value.");
    }
    const stored = await this.vault.read(recordId);
    let seal: SealView | null = null;
    let error: string | undefined;
    try {
      await this.chain.refresh();
      seal = await this.chain.sealOf(recordId);
    } catch (err) {
      error = errorText(err);
    }
    const matches =
      stored.recoverable && stored.payload !== null && seal?.pinned
        ? commitmentOf(stored.payload).toLowerCase() === seal.commitment.toLowerCase()
        : null;
    const txHash = stored.meta?.txHash ?? null;
    const links = this.chain.linksFor(txHash);
    return {
      ok: !error,
      recordId,
      recoverable: stored.recoverable,
      payload: stored.payload,
      seal,
      matches,
      txHash,
      explorer: links.explorer,
      monadscan: links.monadscan,
      ...(error ? { error } : {}),
    };
  }

  async runStep(step: number): Promise<{ title: string; log: string[]; data: Record<string, unknown> }> {
    if (step === 1) return this.stepDeploy();
    if (step === 2) return this.stepCommit();
    if (step === 3) return this.stepMatch();
    if (step === 4) return this.stepErase();
    if (step === 5) return this.stepGone();
    if (step === 6) return this.stepSeal();
    throw new Error("Step must be 1 through 6.");
  }

  private async stepDeploy() {
    const title = "Deploy or locate the seal contract";
    const log: string[] = [];
    await this.chain.refresh();
    if (this.chain.chainError || this.chain.chainId === null) {
      throw new Error(this.chain.chainError ?? "Monad RPC is unreachable.");
    }
    log.push(`RPC ${this.chain.rpcUrl}`);
    log.push(`Chain id ${this.chain.chainId}.`);
    if (this.chain.contractAddress) {
      const present = await this.chain.hasCode(this.chain.contractAddress);
      if (!present) {
        throw new Error(`No contract code at ${this.chain.contractAddress}.`);
      }
      this.e2e.contract = this.chain.contractAddress;
      log.push(`Located seal ${this.chain.contractAddress}.`);
      log.push("Bytecode is present. No new deploy transaction was sent.");
      return { title, log, data: { contract: this.chain.contractAddress, deployed: false } };
    }
    log.push("WYRVEL_CONTRACT is unset. Deploying WyrvelSeal.");
    const deployed = await this.chain.deploy();
    this.e2e.contract = deployed.address;
    this.e2e.deployTxHash = deployed.txHash;
    log.push(`Deployed seal ${deployed.address}.`);
    log.push(`Deploy transaction ${deployed.txHash}.`);
    const links = this.chain.linksFor(deployed.txHash);
    if (links.explorer) log.push(`Explorer ${links.explorer}`);
    else log.push("This chain is not Monad testnet, so no public explorer link is shown.");
    return {
      title,
      log,
      data: { contract: deployed.address, txHash: deployed.txHash, explorer: links.explorer, deployed: true },
    };
  }

  private async stepCommit() {
    const title = "Commit a payload and pin its hash";
    if (!this.chain.contractAddress && !this.e2e.contract) {
      throw new Error("Run step 1 first so a seal contract is located.");
    }
    const payload = `${E2E_PAYLOAD_PREFIX} ${new Date().toISOString()}`;
    const result = await this.commitPayload(payload);
    this.e2ePayload = payload;
    this.e2e.recordId = result.recordId;
    this.e2e.commitment = result.commitment;
    this.e2e.txHash = result.pin.txHash;
    this.e2e.pinnedAt = result.pin.pinnedAt;
    this.e2e.pinner = result.pin.pinner;
    this.e2e.contract = this.chain.contractAddress;
    const log = [
      `Record ${result.recordId}.`,
      `keccak256 ${result.commitment}.`,
      `Pinned at ${result.pin.pinnedAt} by ${result.pin.pinner}.`,
      `Transaction ${result.pin.txHash}.`,
    ];
    if (result.pin.explorer) log.push(`Explorer ${result.pin.explorer}`);
    else log.push("No public explorer link. The transaction hash is only for this chain.");
    log.push("The payload was not placed in the transaction.");
    return {
      title,
      log,
      data: {
        recordId: result.recordId,
        commitment: result.commitment,
        txHash: result.pin.txHash,
        explorer: result.pin.explorer,
        pinnedAt: result.pin.pinnedAt,
      },
    };
  }

  private async stepMatch() {
    const title = "Verify the payload matches the seal";
    const recordId = this.e2e.recordId;
    if (!recordId) throw new Error("Run step 2 first.");
    const check = await this.checkRecord(recordId);
    if (check.error) throw new Error(check.error);
    if (!check.recoverable || check.payload === null) {
      throw new Error("The payload is not recoverable, so it cannot be matched. Run step 2 before erase.");
    }
    if (!check.seal?.pinned) throw new Error("The seal is not pinned for this record id.");
    if (check.matches !== true) {
      throw new Error("The payload hash does not match the on-chain seal.");
    }
    const log = [
      `Recovered ${Buffer.byteLength(check.payload, "utf8")} bytes from the store.`,
      `Store keccak256 ${commitmentOf(check.payload)}.`,
      `Seal commitment ${check.seal.commitment}.`,
      "The two hashes match.",
      `Record ${recordId}.`,
    ];
    return { title, log, data: { recordId, matches: true, commitment: check.seal.commitment } };
  }

  private async stepErase() {
    const title = "Erase the private copy";
    const recordId = this.e2e.recordId;
    if (!recordId) throw new Error("Run step 2 first.");
    const before = this.e2e.txHash;
    const meta = await this.eraseRecord(recordId);
    const log = [
      `Erased record ${recordId}.`,
      "The store no longer returns the payload.",
      "No seal transaction was sent.",
    ];
    if (before) log.push(`Earlier pin transaction remains ${before}.`);
    return { title, log, data: { recordId, recoverable: false, erasedAt: meta.erasedAt, txHash: before } };
  }

  private async stepGone() {
    const title = "Verify the payload is unrecoverable";
    const recordId = this.e2e.recordId;
    if (!recordId) throw new Error("Run step 2 first.");
    const stored = await this.vault.read(recordId);
    if (stored.recoverable || stored.payload !== null) {
      throw new Error("The payload is still recoverable from the store.");
    }
    if (this.e2ePayload && (await this.vault.directoryHolds(this.e2ePayload))) {
      throw new Error("The store directory still contains the payload.");
    }
    this.e2ePayload = null;
    const log = [
      `Record ${recordId}.`,
      "A read did not return the payload.",
      "The store directory does not contain that payload.",
      "The private copy is unrecoverable from WYRVEL.",
    ];
    return { title, log, data: { recordId, recoverable: false } };
  }

  private async stepSeal() {
    const title = "Verify the on-chain seal is unchanged";
    const recordId = this.e2e.recordId;
    const expected = this.e2e.commitment;
    if (!recordId || !expected || this.e2e.pinnedAt === null || !this.e2e.pinner) {
      throw new Error("Run step 2 first.");
    }
    await this.chain.refresh();
    const seal = await this.chain.sealOf(recordId);
    if (!seal.pinned) throw new Error("The seal is missing.");
    if (seal.commitment.toLowerCase() !== expected.toLowerCase()) {
      throw new Error("The on-chain commitment changed.");
    }
    if (seal.pinnedAt !== this.e2e.pinnedAt) throw new Error("The pin timestamp changed.");
    if (seal.pinner.toLowerCase() !== this.e2e.pinner.toLowerCase()) {
      throw new Error("The pinner changed.");
    }
    const stored = await this.vault.read(recordId);
    const log = [
      `Seal commitment ${seal.commitment}.`,
      `Pinned at ${seal.pinnedAt} by ${seal.pinner}.`,
      "Commitment, timestamp, and pinner match the commit.",
    ];
    if (this.e2e.txHash) log.push(`Pin transaction ${this.e2e.txHash}.`);
    log.push(stored.recoverable ? "The store still returned a payload." : "The store did not return a payload.");
    return {
      title,
      log,
      data: {
        recordId,
        commitment: seal.commitment,
        pinnedAt: seal.pinnedAt,
        pinner: seal.pinner,
        recoverable: stored.recoverable,
        txHash: this.e2e.txHash,
      },
    };
  }
}
