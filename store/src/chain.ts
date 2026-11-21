import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, hexlify, type InterfaceAbi, type TransactionRequest } from "ethers";
import { redactSecrets } from "./gate.js";
import { NonceBook, bufferedGas } from "./nonce.js";

export const MONAD_TESTNET_CHAIN_ID = 10143;
const VISION_TX = "https://testnet.monadvision.com/tx/";
const SCAN_TX = "https://testnet.monadscan.com/tx/";

export type SealView = {
  pinned: boolean;
  commitment: string;
  pinnedAt: number;
  pinner: string;
};

export type PinReceipt = {
  txHash: string;
  blockNumber: number;
  pinnedAt: number;
  pinner: string;
  chainId: number;
  explorer: string | null;
  monadscan: string | null;
  gasUsed: string | null;
  /** Monad charges this limit, not receipt gasUsed. */
  gasLimit: string | null;
  effectiveGasPrice: string | null;
  feeWei: string | null;
  /** Submitter clock: send accepted until the receipt. Not a finality figure. */
  receiptWaitMs: number | null;
};

type Artifact = {
  abi: InterfaceAbi;
  bytecode: string;
};

function publicExplorer(chainId: number | null, txHash: string): { explorer: string | null; monadscan: string | null } {
  if (chainId !== MONAD_TESTNET_CHAIN_ID) return { explorer: null, monadscan: null };
  return { explorer: `${VISION_TX}${txHash}`, monadscan: `${SCAN_TX}${txHash}` };
}

export function errorText(err: unknown, secrets: Array<string | null | undefined> = []): string {
  let raw: string;
  if (err && typeof err === "object" && "shortMessage" in err) {
    raw = String((err as { shortMessage: unknown }).shortMessage);
  } else if (err instanceof Error) {
    raw = err.message;
  } else {
    raw = String(err);
  }
  return redactSecrets(raw, secrets).slice(0, 600);
}

export class Chain {
  private provider: JsonRpcProvider | null = null;
  private abi: InterfaceAbi | null = null;
  private bytecode = "";
  private readonly nonces = new NonceBook();
  private sendLock: Promise<void> = Promise.resolve();
  chainId: number | null = null;
  chainError: string | null = null;
  contractAddress: string | null;

  constructor(
    readonly rpcUrl: string,
    private readonly privateKey: string | null,
    contractAddress: string | null,
  ) {
    this.contractAddress = contractAddress;
  }

  async loadArtifact(): Promise<void> {
    const path = join(dirname(fileURLToPath(import.meta.url)), "artifact.json");
    const parsed = JSON.parse(await readFile(path, "utf8")) as Artifact;
    this.abi = parsed.abi;
    this.bytecode = parsed.bytecode.startsWith("0x") ? parsed.bytecode : `0x${parsed.bytecode}`;
  }

  async refresh(): Promise<void> {
    if (!this.abi) await this.loadArtifact();
    if (!this.rpcUrl) {
      this.chainId = null;
      this.chainError = "RPC_URL is not set.";
      return;
    }
    if (!this.provider) this.provider = new JsonRpcProvider(this.rpcUrl);
    try {
      const network = await withTimeout(this.provider.getNetwork(), 8_000, "Monad RPC timed out.");
      this.chainId = Number(network.chainId);
      this.chainError = null;
    } catch (err) {
      this.chainId = null;
      this.chainError = errorText(err);
      this.provider.destroy();
      this.provider = null;
    }
  }

  private requireProvider(): JsonRpcProvider {
    if (!this.provider || this.chainError || this.chainId === null) {
      throw new Error(this.chainError ?? "Monad RPC is unreachable.");
    }
    return this.provider;
  }

  signerAddress(): string | null {
    if (!this.privateKey) return null;
    try {
      return new Wallet(this.privateKey).address;
    } catch {
      return null;
    }
  }

  private signer(): Wallet {
    if (!this.privateKey) {
      throw new Error("PRIVATE_KEY is not set. WYRVEL will not invent a transaction.");
    }
    try {
      return new Wallet(this.privateKey, this.requireProvider());
    } catch {
      throw new Error("PRIVATE_KEY is not a usable signing key. No transaction was sent.");
    }
  }

  private scrub(err: unknown): Error {
    return new Error(errorText(err, [this.privateKey]));
  }

  close(): void {
    this.provider?.destroy();
    this.provider = null;
  }

  async balanceOf(address: string): Promise<bigint> {
    return this.requireProvider().getBalance(address);
  }

  private async withSendLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.sendLock;
    let release: () => void = () => {};
    this.sendLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async gasLimitFor(tx: TransactionRequest, floor: bigint): Promise<{ estimate: bigint; gasLimit: bigint }> {
    let estimate: bigint;
    try {
      estimate = await this.requireProvider().estimateGas(tx);
    } catch (err) {
      throw new Error(`Gas estimate failed. The transaction was not sent. ${errorText(err, [this.privateKey])}`);
    }
    return { estimate, gasLimit: bufferedGas(estimate, floor) };
  }

  private contract(address: string, signer?: Wallet): Contract {
    if (!this.abi) throw new Error("Seal ABI is not loaded.");
    return new Contract(address, this.abi, signer ?? this.requireProvider());
  }

  async hasCode(address: string): Promise<boolean> {
    const code = await this.requireProvider().getCode(address);
    return code !== "0x" && code !== "0x0";
  }

  async deploy(): Promise<{ address: string; txHash: string; gasEstimate: bigint; gasLimit: bigint }> {
    if (!this.abi || !this.bytecode) await this.loadArtifact();
    return this.withSendLock(async () => {
      const signer = this.signer();
      const from = await signer.getAddress();
      const factory = new ContractFactory(this.abi!, this.bytecode, signer);
      const unsigned = await factory.getDeployTransaction();
      const { estimate, gasLimit } = await this.gasLimitFor({ ...unsigned, from }, 1_000_000n);
      const nonce = await this.nonces.take(() => this.requireProvider().getTransactionCount(from, "pending"));
      try {
        const deployed = await factory.deploy({ nonce, gasLimit });
        const tx = deployed.deploymentTransaction();
        if (!tx) throw new Error("Deploy did not produce a transaction.");
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) throw new Error("Deploy transaction failed.");
        const address = await deployed.getAddress();
        this.contractAddress = address;
        return { address, txHash: receipt.hash, gasEstimate: estimate, gasLimit };
      } catch (err) {
        this.nonces.reset();
        throw this.scrub(err);
      }
    });
  }

  canSign(): boolean {
    return Boolean(this.privateKey && this.contractAddress && this.provider && !this.chainError && this.chainId !== null);
  }

  async txState(txHash: string): Promise<"pending" | "mined" | "dropped"> {
    const provider = this.requireProvider();
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) return receipt.status === 1 ? "mined" : "dropped";
    const tx = await provider.getTransaction(txHash);
    return tx ? "pending" : "dropped";
  }

  async pin(
    recordId: string,
    commitment: string,
    onBroadcast?: (txHash: string) => Promise<void>,
  ): Promise<PinReceipt> {
    if (!this.contractAddress) {
      throw new Error("WYRVEL_CONTRACT is not set. Deploy the seal or run e2e step 1.");
    }
    return this.withSendLock(async () => {
      const signer = this.signer();
      const from = await signer.getAddress();
      const seal = this.contract(this.contractAddress!, signer);
      const data = seal.interface.encodeFunctionData("commit", [recordId, commitment]);
      const { gasLimit } = await this.gasLimitFor({ to: this.contractAddress, data, from }, 300_000n);
      const nonce = await this.nonces.take(() => this.requireProvider().getTransactionCount(from, "pending"));
      let receipt;
      let receiptWaitMs: number | null = null;
      try {
        const tx = await signer.sendTransaction({ to: this.contractAddress, data, from, nonce, gasLimit });
        if (onBroadcast) await onBroadcast(tx.hash);
        const sentAt = Date.now();
        receipt = await tx.wait();
        receiptWaitMs = Date.now() - sentAt;
      } catch (err) {
        this.nonces.reset();
        throw this.scrub(err);
      }
      return this.receiptToPin(seal, receipt, recordId, commitment, receiptWaitMs, gasLimit);
    });
  }

  private receiptToPin(
    seal: Contract,
    receipt: Awaited<ReturnType<Awaited<ReturnType<Wallet["sendTransaction"]>>["wait"]>>,
    recordId: string,
    commitment: string,
    receiptWaitMs: number | null,
    gasLimit: bigint,
  ): PinReceipt {
    if (!receipt || receipt.status !== 1) {
      throw new Error("Pin transaction failed.");
    }
    const parsed = receipt.logs
      .map((log) => {
        try {
          return seal.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event: { name: string } | null) => event?.name === "Committed");
    if (!parsed) throw new Error("Pin transaction did not emit Committed.");
    const eventRecord = hexlify(parsed.args.recordId as string);
    const eventCommitment = hexlify(parsed.args.commitment as string);
    if (eventRecord.toLowerCase() !== recordId.toLowerCase()) {
      throw new Error("Pin event record id did not match.");
    }
    if (eventCommitment.toLowerCase() !== commitment.toLowerCase()) {
      throw new Error("Pin event commitment did not match.");
    }
    const chainId = this.chainId ?? MONAD_TESTNET_CHAIN_ID;
    const links = publicExplorer(chainId, receipt.hash);
    const gasUsed = receipt.gasUsed ?? null;
    const effectiveGasPrice = receipt.gasPrice ?? null;
    // Monad charges the transaction gas limit, not execution gasUsed.
    const feeWei = effectiveGasPrice === null ? null : gasLimit * effectiveGasPrice;
    return {
      txHash: receipt.hash,
      blockNumber: Number(receipt.blockNumber),
      pinnedAt: Number(parsed.args.pinnedAt),
      pinner: String(parsed.args.pinner),
      chainId,
      explorer: links.explorer,
      monadscan: links.monadscan,
      gasUsed: gasUsed === null ? null : gasUsed.toString(),
      gasLimit: gasLimit.toString(),
      effectiveGasPrice: effectiveGasPrice === null ? null : effectiveGasPrice.toString(),
      feeWei: feeWei === null ? null : feeWei.toString(),
      receiptWaitMs,
    };
  }

  async sealOf(recordId: string): Promise<SealView> {
    if (!this.contractAddress) {
      throw new Error("WYRVEL_CONTRACT is not set. Deploy the seal or run e2e step 1.");
    }
    const seal = this.contract(this.contractAddress);
    const result = await seal.getFunction("sealOf").staticCall(recordId);
    return {
      commitment: hexlify(result.commitment as string),
      pinnedAt: Number(result.pinnedAt),
      pinner: String(result.pinner),
      pinned: Boolean(result.pinned),
    };
  }

  linksFor(txHash: string | null): { explorer: string | null; monadscan: string | null } {
    if (!txHash) return { explorer: null, monadscan: null };
    return publicExplorer(this.chainId, txHash);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
