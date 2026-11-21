/**
 * Private permissioned chain for the WYRVEL proof of concept.
 *
 * This is block-body pruning on a leader-ordered chain. It is not BFT.
 * Processes started together on one machine are one failure domain.
 * Headers stay hash-linked after a prune. The active body file can be removed.
 * This is not chameleon-hash redaction, not encryption-key destruction,
 * and not a claim that backups or snapshots lost their copies.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { open, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNet } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GENESIS_PREV = "0".repeat(64);
export const MAX_PAYLOAD_BYTES = 4096;
const NODE_IDS = ["leader", "replica-a", "replica-b"] as const;

export type Role = "leader" | "replica";
export type Kind = "data" | "prune";

export type Member = {
  id: string;
  role: Role;
  publicKeyPem: string;
};

export type Header = {
  v: 1;
  index: number;
  prev: string;
  kind: Kind;
  body: string;
  target: number | null;
  signer: string;
};

export type Envelope = {
  header: Header;
  signature: string;
  payloadB64: string | null;
};

export type Ack = { ok: boolean; code: string };

export type Peer = {
  id: string;
  propose(envelope: Envelope): Promise<Ack>;
  commit(): Promise<Ack>;
  abort(): Promise<Ack>;
};

export type ReplicaReport = { id: string; ok: boolean; code: string };

export type ChainResult = {
  ok: boolean;
  status: "accepted" | "rejected" | "incomplete";
  code: string;
  index: number | null;
  hash: string | null;
  bodyCommitment: string | null;
  replicas: ReplicaReport[];
};

export type Observe = {
  nodeId: string;
  role: Role;
  ready: boolean;
  height: number;
  found: boolean;
  headerHash: string | null;
  bodyCommitment: string | null;
  kind: Kind | null;
  pruned: boolean;
  payloadPresent: boolean;
  payload: string | null;
  code: string;
};

type Stored = { header: Header; signature: string; pruned: boolean };

type StateFile = {
  v: 1;
  committed: Stored[];
  pending: { header: Header; signature: string } | null;
};

export class ChainError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalHeader(header: Header): string {
  const target = header.target === null ? "-" : String(header.target);
  return `v1\n${header.index}\n${header.prev}\n${header.kind}\n${header.body}\n${target}\n${header.signer}`;
}

export function headerHash(header: Header): string {
  return sha256Hex(canonicalHeader(header));
}

export function pruneCommitment(target: number, targetHeaderHash: string): string {
  return sha256Hex(`prune ${target} ${targetHeaderHash}`);
}

export function createIdentity(id: string, role: Role): Member & { privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    id,
    role,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function signHeader(privateKeyPem: string, header: Header): string {
  const key = createPrivateKey(privateKeyPem);
  return sign(null, Buffer.from(canonicalHeader(header), "utf8"), key).toString("base64");
}

export function verifyHeader(publicKeyPem: string, header: Header, signatureB64: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(null, Buffer.from(canonicalHeader(header), "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

type Logger = (entry: Record<string, string | number | boolean | null>) => void;

export class PrivateNode {
  readonly id: string;
  readonly role: Role;
  ready = false;
  private readonly dir: string;
  private readonly privateKeyPem: string;
  private readonly members: Member[];
  private readonly log: Logger;
  private committed: Stored[] = [];
  private pending: { header: Header; signature: string } | null = null;
  private tail: Promise<void> = Promise.resolve();

  private constructor(
    id: string,
    role: Role,
    dir: string,
    privateKeyPem: string,
    members: Member[],
    log: Logger,
  ) {
    this.id = id;
    this.role = role;
    this.dir = dir;
    this.privateKeyPem = privateKeyPem;
    this.members = members;
    this.log = log;
  }

  static async open(
    dir: string,
    membershipPath: string,
    id: string,
    log: Logger = () => undefined,
  ): Promise<PrivateNode> {
    const membership = JSON.parse(await readFile(membershipPath, "utf8")) as { members: Member[] };
    const keyFile = JSON.parse(await readFile(join(dir, "key.json"), "utf8")) as { privateKeyPem: string };
    const member = membership.members.find((item) => item.id === id);
    if (!member) throw new ChainError("unauthorized");
    if (member.role !== "leader" && member.role !== "replica") throw new ChainError("unauthorized");
    const node = new PrivateNode(id, member.role, dir, keyFile.privateKeyPem, membership.members, log);
    await mkdir(join(dir, "bodies"), { recursive: true });
    await node.load();
    node.ready = member.role === "leader";
    if (member.role === "leader" && node.committed.length === 0) {
      await node.writeGenesis();
    }
    if (node.pending) await node.abort();
    return node;
  }

  height(): number {
    return this.committed.length - 1;
  }

  private leader(): Member {
    const leader = this.members.find((item) => item.role === "leader");
    if (!leader) throw new ChainError("unauthorized");
    return leader;
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private note(op: string, code: string, index: number | null = null): void {
    this.log({ node: this.id, op, code, index });
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath(), "utf8")) as StateFile;
      this.committed = Array.isArray(parsed.committed) ? parsed.committed : [];
      this.pending = parsed.pending ?? null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new ChainError("corrupt");
    }
  }

  private statePath(): string {
    return join(this.dir, "state.json");
  }

  private bodyPath(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index > 1_000_000) throw new ChainError("missing");
    return join(this.dir, "bodies", String(index));
  }

  private pendingPath(): string {
    return join(this.dir, "bodies", "pending");
  }

  private async persist(): Promise<void> {
    const body: StateFile = { v: 1, committed: this.committed, pending: this.pending };
    await atomicWrite(this.statePath(), JSON.stringify(body));
  }

  private async writeGenesis(): Promise<void> {
    const payload = Buffer.alloc(0);
    const header: Header = {
      v: 1,
      index: 0,
      prev: GENESIS_PREV,
      kind: "data",
      body: sha256Hex(payload),
      target: null,
      signer: this.id,
    };
    const signature = signHeader(this.privateKeyPem, header);
    await atomicWrite(this.bodyPath(0), payload);
    this.committed = [{ header, signature, pruned: false }];
    this.pending = null;
    await this.persist();
    this.note("genesis", "accepted", 0);
  }

  async stageData(payload: Buffer): Promise<Envelope> {
    return this.lock(async () => {
      if (this.role !== "leader") throw new ChainError("not-leader");
      if (payload.length === 0) throw new ChainError("empty");
      if (payload.length > MAX_PAYLOAD_BYTES) throw new ChainError("too-large");
      if (this.pending) throw new ChainError("busy");
      const header = this.nextHeader("data", sha256Hex(payload), null);
      const signature = signHeader(this.privateKeyPem, header);
      await atomicWrite(this.pendingPath(), payload);
      this.pending = { header, signature };
      await this.persist();
      this.note("stage-data", "accepted", header.index);
      return { header, signature, payloadB64: payload.toString("base64") };
    });
  }

  async stagePrune(target: number): Promise<Envelope> {
    return this.lock(async () => {
      if (this.role !== "leader") throw new ChainError("not-leader");
      if (this.pending) throw new ChainError("busy");
      const current = this.committed[target];
      if (!current || current.header.kind !== "data" || target === 0) throw new ChainError("missing");
      if (current.pruned || this.pruneOf(target)) throw new ChainError("already-pruned");
      const header = this.nextHeader("prune", pruneCommitment(target, headerHash(current.header)), target);
      const signature = signHeader(this.privateKeyPem, header);
      this.pending = { header, signature };
      await this.persist();
      this.note("stage-prune", "accepted", header.index);
      return { header, signature, payloadB64: null };
    });
  }

  async acceptRemote(envelope: Envelope): Promise<Ack> {
    return this.lock(async () => {
      try {
        this.checkEnvelope(envelope);
        const hash = headerHash(envelope.header);
        const existing = this.committed[envelope.header.index];
        if (existing) {
          if (headerHash(existing.header) === hash) return { ok: true, code: "already" };
          return { ok: false, code: "replay" };
        }
        if (envelope.header.index !== this.committed.length) {
          return { ok: false, code: envelope.header.index < this.committed.length ? "replay" : "gap" };
        }
        const prev = this.committed.length === 0 ? GENESIS_PREV : headerHash(this.committed[this.committed.length - 1]!.header);
        if (envelope.header.prev !== prev) return { ok: false, code: "gap" };
        if (this.pending && headerHash(this.pending.header) !== hash) return { ok: false, code: "conflict" };
        if (envelope.header.kind === "data") {
          const payload = Buffer.from(envelope.payloadB64 ?? "", "base64");
          if (sha256Hex(payload) !== envelope.header.body) return { ok: false, code: "tamper" };
          await atomicWrite(this.pendingPath(), payload);
        } else {
          this.checkPruneTarget(envelope.header);
        }
        this.pending = { header: envelope.header, signature: envelope.signature };
        await this.persist();
        this.note("propose", "accepted", envelope.header.index);
        return { ok: true, code: "accepted" };
      } catch (err) {
        const code = err instanceof ChainError ? err.code : "rejected";
        this.note("propose", code, envelope.header?.index ?? null);
        return { ok: false, code };
      }
    });
  }

  async commit(): Promise<Ack> {
    return this.lock(async () => {
      if (!this.pending) return { ok: true, code: "already" };
      const pending = this.pending;
      if (pending.header.kind === "data") {
        const payload = await readFile(this.pendingPath());
        if (sha256Hex(payload) !== pending.header.body) throw new ChainError("tamper");
        await atomicWrite(this.bodyPath(pending.header.index), payload);
        await rm(this.pendingPath(), { force: true });
        this.committed.push({ header: pending.header, signature: pending.signature, pruned: false });
      } else {
        const target = pending.header.target;
        if (target === null) throw new ChainError("missing");
        this.committed.push({ header: pending.header, signature: pending.signature, pruned: false });
        const victim = this.committed[target];
        if (victim) victim.pruned = true;
        this.pending = null;
        await this.persist();
        await this.wipeBody(target);
        this.note("commit-prune", "accepted", pending.header.index);
        return { ok: true, code: "committed" };
      }
      this.pending = null;
      await this.persist();
      this.note("commit-data", "accepted", pending.header.index);
      return { ok: true, code: "committed" };
    });
  }

  async abort(): Promise<Ack> {
    return this.lock(async () => {
      this.pending = null;
      await rm(this.pendingPath(), { force: true });
      await this.persist();
      this.note("abort", "accepted", null);
      return { ok: true, code: "aborted" };
    });
  }

  async exportChain(): Promise<{
    id: string;
    height: number;
    blocks: Array<{ header: Header; signature: string; pruned: boolean; payloadB64: string | null }>;
  }> {
    return this.lock(async () => {
      const blocks = [];
      for (const entry of this.committed) {
        const pruned = entry.pruned || entry.header.kind === "prune";
        let payloadB64: string | null = null;
        if (!pruned && entry.header.kind === "data") {
          try {
            payloadB64 = (await readFile(this.bodyPath(entry.header.index))).toString("base64");
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        }
        blocks.push({ header: entry.header, signature: entry.signature, pruned, payloadB64 });
      }
      return { id: this.id, height: this.height(), blocks };
    });
  }

  async importSync(blocks: Array<{ header: Header; signature: string; pruned: boolean; payloadB64: string | null }>): Promise<void> {
    await this.lock(async () => {
      this.ready = false;
      if (blocks.length < this.committed.length) throw new ChainError("ahead");
      let prev = GENESIS_PREV;
      for (const block of blocks) {
        this.checkEnvelope({ header: block.header, signature: block.signature, payloadB64: block.payloadB64 });
        if (block.header.prev !== prev) throw new ChainError("gap");
        if (block.pruned && block.payloadB64) throw new ChainError("tamper");
        if (!block.pruned && block.header.kind === "data") {
          const payload = Buffer.from(block.payloadB64 ?? "", "base64");
          if (sha256Hex(payload) !== block.header.body) throw new ChainError("tamper");
        }
        if (block.header.kind === "prune") this.checkPruneTarget(block.header, blocks);
        prev = headerHash(block.header);
      }
      this.pending = null;
      await rm(this.pendingPath(), { force: true });
      const next: Stored[] = [];
      for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i]!;
        const local = this.committed[i];
        if (local && headerHash(local.header) !== headerHash(block.header)) throw new ChainError("conflict");
        next.push({ header: block.header, signature: block.signature, pruned: block.pruned || block.header.kind === "prune" });
      }
      this.committed = next;
      for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i]!;
        if (block.header.kind === "prune" && block.header.target !== null) {
          const victim = this.committed[block.header.target];
          if (victim) victim.pruned = true;
          await this.wipeBody(block.header.target);
        } else if (block.pruned) {
          await this.wipeBody(block.header.index);
        } else if (block.payloadB64) {
          await atomicWrite(this.bodyPath(block.header.index), Buffer.from(block.payloadB64, "base64"));
        }
      }
      for (const entry of this.committed) {
        if (entry.pruned || entry.header.kind === "prune") {
          await this.wipeBody(entry.header.index);
          if (entry.header.kind === "prune" && entry.header.target !== null) await this.wipeBody(entry.header.target);
        }
      }
      await this.persist();
      this.ready = true;
      this.note("sync", "accepted", this.height());
    });
  }

  async observe(index: number, forceClosed = false): Promise<Observe> {
    return this.lock(async () => {
      await this.applyLocalPrunes();
      const entry = this.committed[index];
      const base = {
        nodeId: this.id,
        role: this.role,
        ready: this.ready,
        height: this.height(),
        found: Boolean(entry),
        headerHash: entry ? headerHash(entry.header) : null,
        bodyCommitment: entry?.header.kind === "data" ? entry.header.body : null,
        kind: entry?.header.kind ?? null,
        pruned: Boolean(entry?.pruned) || this.pruneOf(index),
        payloadPresent: false,
        payload: null as string | null,
        code: "absent",
      };
      if (!entry) {
        base.code = forceClosed || !this.ready ? "fail-closed" : "missing";
        return base;
      }
      if (base.pruned) {
        await this.wipeBody(index);
        base.payloadPresent = false;
        base.payload = null;
        base.code = "pruned";
        return base;
      }
      if (forceClosed || !this.ready) {
        base.code = "fail-closed";
        return base;
      }
      try {
        const payload = await readFile(this.bodyPath(index));
        base.payloadPresent = true;
        base.payload = payload.toString("utf8");
        base.code = "present";
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        base.code = "absent";
      }
      return base;
    });
  }

  async syncFrom(leaderUrl: string): Promise<boolean> {
    try {
      const exported = (await getJson(`${leaderUrl}/export`)) as {
        blocks: Array<{ header: Header; signature: string; pruned: boolean; payloadB64: string | null }>;
      };
      if (!exported?.blocks) throw new ChainError("gap");
      await this.importSync(exported.blocks);
      return true;
    } catch (err) {
      this.ready = false;
      this.note("sync", err instanceof ChainError ? err.code : "unreachable", null);
      return false;
    }
  }

  private nextHeader(kind: Kind, body: string, target: number | null): Header {
    const prev = this.committed.length === 0 ? GENESIS_PREV : headerHash(this.committed[this.committed.length - 1]!.header);
    return {
      v: 1,
      index: this.committed.length,
      prev,
      kind,
      body,
      target,
      signer: this.id,
    };
  }

  private checkEnvelope(envelope: Envelope): void {
    const header = envelope.header;
    if (!header || header.v !== 1 || (header.kind !== "data" && header.kind !== "prune")) throw new ChainError("tamper");
    const signer = this.members.find((item) => item.id === header.signer);
    if (!signer) throw new ChainError("unauthorized");
    if (!verifyHeader(signer.publicKeyPem, header, envelope.signature)) throw new ChainError("bad-signature");
    if (signer.role !== "leader" || signer.id !== this.leader().id) throw new ChainError("unauthorized");
  }

  private checkPruneTarget(
    header: Header,
    source: Array<{ header: Header }> = this.committed,
  ): void {
    if (header.target === null || header.target <= 0) throw new ChainError("missing");
    const target = source[header.target];
    if (!target || target.header.kind !== "data") throw new ChainError("missing");
    const expect = pruneCommitment(header.target, headerHash(target.header));
    if (header.body !== expect) throw new ChainError("tamper");
  }

  private pruneOf(target: number): boolean {
    return this.committed.some((entry) => entry.header.kind === "prune" && entry.header.target === target);
  }

  private async applyLocalPrunes(): Promise<void> {
    for (const entry of this.committed) {
      if (entry.header.kind === "prune" && entry.header.target !== null) {
        const victim = this.committed[entry.header.target];
        if (victim) victim.pruned = true;
        await this.wipeBody(entry.header.target);
      }
    }
  }

  private async wipeBody(index: number): Promise<void> {
    const path = this.bodyPath(index);
    let handle;
    try {
      handle = await open(path, "r+");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    try {
      const { size } = await handle.stat();
      if (size > 0) {
        const blank = Buffer.alloc(size);
        const { bytesWritten } = await handle.write(blank, 0, size, 0);
        if (bytesWritten !== size) throw new ChainError("fail-closed");
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
    const leftover = await readFile(path);
    if (leftover.some((byte) => byte !== 0)) throw new ChainError("fail-closed");
    await rm(path, { force: true });
  }
}

export async function replicate(
  local: PrivateNode,
  peers: Peer[],
  stage: () => Promise<Envelope>,
): Promise<ChainResult> {
  let envelope: Envelope;
  try {
    envelope = await stage();
  } catch (err) {
    return {
      ok: false,
      status: "rejected",
      code: err instanceof ChainError ? err.code : "rejected",
      index: null,
      hash: null,
      bodyCommitment: null,
      replicas: [],
    };
  }
  const reports: ReplicaReport[] = [];
  for (const peer of peers) {
    try {
      const ack = await peer.propose(envelope);
      reports.push({ id: peer.id, ok: Boolean(ack.ok), code: ack.code || "rejected" });
    } catch {
      reports.push({ id: peer.id, ok: false, code: "unreachable" });
    }
  }
  if (reports.some((item) => !item.ok)) {
    for (let i = 0; i < peers.length; i += 1) {
      if (reports[i]?.ok) {
        try {
          await peers[i]!.abort();
        } catch {
          reports[i] = { id: peers[i]!.id, ok: false, code: "abort-failed" };
        }
      }
    }
    await local.abort();
    const failed = reports.find((item) => !item.ok);
    return {
      ok: false,
      status: "rejected",
      code: failed?.code === "unreachable" ? "missing-replica" : failed?.code ?? "rejected",
      index: envelope.header.index,
      hash: headerHash(envelope.header),
      bodyCommitment: envelope.header.body,
      replicas: reports,
    };
  }
  const commits: ReplicaReport[] = [];
  for (const peer of peers) {
    try {
      const ack = await peer.commit();
      commits.push({ id: peer.id, ok: Boolean(ack.ok), code: ack.code || "rejected" });
    } catch {
      commits.push({ id: peer.id, ok: false, code: "unreachable" });
    }
  }
  try {
    const ack = await local.commit();
    commits.push({ id: local.id, ok: Boolean(ack.ok), code: ack.code });
  } catch (err) {
    commits.push({ id: local.id, ok: false, code: err instanceof ChainError ? err.code : "rejected" });
  }
  const hash = headerHash(envelope.header);
  if (commits.every((item) => item.ok)) {
    return {
      ok: true,
      status: "accepted",
      code: "accepted",
      index: envelope.header.index,
      hash,
      bodyCommitment: envelope.header.body,
      replicas: commits,
    };
  }
  return {
    ok: false,
    status: "incomplete",
    code: "incomplete",
    index: envelope.header.index,
    hash,
    bodyCommitment: envelope.header.body,
    replicas: commits,
  };
}

export function memoryPeer(node: PrivateNode): Peer {
  return {
    id: node.id,
    propose: (envelope) => node.acceptRemote(envelope),
    commit: async () => node.commit(),
    abort: async () => node.abort(),
  };
}

export async function ensureLayout(chainRoot: string): Promise<void> {
  await mkdir(chainRoot, { recursive: true });
  const membershipPath = join(chainRoot, "membership.json");
  try {
    await readFile(membershipPath, "utf8");
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const members: Member[] = [];
  for (const id of NODE_IDS) {
    const role: Role = id === "leader" ? "leader" : "replica";
    const identity = createIdentity(id, role);
    const dir = join(chainRoot, "nodes", id);
    await mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, "key.json"), JSON.stringify({ id, privateKeyPem: identity.privateKeyPem }), 0o600);
    members.push({ id, role, publicKeyPem: identity.publicKeyPem });
  }
  await atomicWrite(membershipPath, JSON.stringify({ v: 1, members }));
}

export type Cluster = {
  ports: Record<string, number>;
  topology(): Promise<Record<string, unknown>>;
  append(payload: string): Promise<ChainResult>;
  prune(index: number): Promise<ChainResult>;
  observe(index: number): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
};

export async function startCluster(dataRoot: string, ports?: [number, number, number]): Promise<Cluster> {
  const chainRoot = join(dataRoot, "chain");
  await ensureLayout(chainRoot);
  const chosen = ports ?? ((await Promise.all([freePort(), freePort(), freePort()])) as [number, number, number]);
  const ids = [...NODE_IDS];
  const portOf: Record<string, number> = {
    leader: chosen[0],
    "replica-a": chosen[1],
    "replica-b": chosen[2],
  };
  const urlOf = (id: string) => `http://127.0.0.1:${portOf[id]}`;
  const entry = fileURLToPath(import.meta.url);
  const children: ChildProcess[] = [];
  for (const id of ids) {
    const peers = ids
      .filter((other) => other !== id && other !== "leader")
      .map((other) => `${other}=${urlOf(other)}`)
      .join(",");
    const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        CHAIN_COMMAND: "node",
        CHAIN_ID: id,
        CHAIN_DIR: join(chainRoot, "nodes", id),
        CHAIN_MEMBERSHIP: join(chainRoot, "membership.json"),
        CHAIN_PORT: String(portOf[id]),
        CHAIN_LEADER_URL: id === "leader" ? "" : urlOf("leader"),
        CHAIN_PEERS: id === "leader" ? peers : "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\n+/)) {
        if (!line.trim()) continue;
        if (/PRIVATE KEY|payloadB64|privateKey/i.test(line)) continue;
        process.stdout.write(`${line}\n`);
      }
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    children.push(child);
  }
  const leaderUrl = urlOf("leader");
  const stopChildren = () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  };
  try {
    await waitHealthy(leaderUrl);
    for (const id of ["replica-a", "replica-b"]) {
      await waitHealthy(urlOf(id));
      await postJson(`${urlOf(id)}/sync`, {});
    }
  } catch (err) {
    stopChildren();
    throw err;
  }

  return {
    ports: portOf,
    async topology() {
      const nodes = [];
      for (const id of ids) {
        try {
          const health = (await getJson(urlOf(id) + "/health")) as { role?: string; height?: number; ready?: boolean };
          nodes.push({ id, role: health.role ?? null, url: urlOf(id), reachable: true, height: health.height ?? null, ready: Boolean(health.ready) });
        } catch {
          nodes.push({ id, role: id === "leader" ? "leader" : "replica", url: urlOf(id), reachable: false, height: null, ready: false });
        }
      }
      return {
        ok: true,
        mechanism: "block-body-pruning",
        consensus: "leader-ordered",
        bft: false,
        failureDomain: "single-host-process-simulation",
        namespace: "chain",
        nodes,
      };
    },
    append(payload: string) {
      return postJson(`${leaderUrl}/client/append`, { payload }) as Promise<ChainResult>;
    },
    prune(index: number) {
      return postJson(`${leaderUrl}/client/prune`, { index }) as Promise<ChainResult>;
    },
    async observe(index: number) {
      const nodes = [];
      for (const id of ids) {
        try {
          nodes.push(await getJson(`${urlOf(id)}/observe?index=${index}`));
        } catch {
          nodes.push({
            nodeId: id,
            role: id === "leader" ? "leader" : "replica",
            ready: false,
            height: null,
            found: false,
            headerHash: null,
            bodyCommitment: null,
            pruned: false,
            payloadPresent: false,
            payload: null,
            code: "unreachable",
          });
        }
      }
      return { ok: true, index, nodes };
    },
    async stop() {
      for (const child of children) child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 200));
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
  };
}

async function runNodeProcess(): Promise<void> {
  const id = process.env.CHAIN_ID ?? "";
  const dir = process.env.CHAIN_DIR ?? "";
  const membership = process.env.CHAIN_MEMBERSHIP ?? "";
  const port = Number(process.env.CHAIN_PORT ?? "0");
  const leaderUrl = process.env.CHAIN_LEADER_URL || null;
  const node = await PrivateNode.open(dir, membership, id, (entry) => {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  });
  if (node.role !== "leader" && leaderUrl) await node.syncFrom(leaderUrl);
  const peers = parsePeers(process.env.CHAIN_PEERS ?? "");
  const server = createHttp(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, id: node.id, role: node.role, height: node.height(), ready: node.ready });
      }
      if (req.method === "GET" && url.pathname === "/export") {
        return send(res, 200, await node.exportChain());
      }
      if (req.method === "GET" && url.pathname === "/observe") {
        const index = Number(url.searchParams.get("index"));
        if (!Number.isInteger(index)) return send(res, 400, { ok: false, code: "missing" });
        if (node.role !== "leader") {
          if (!leaderUrl || !(await node.syncFrom(leaderUrl))) {
            return send(res, 200, await node.observe(index, true));
          }
        }
        return send(res, 200, await node.observe(index));
      }
      const body = req.method === "GET" ? null : await readBody(req);
      if (req.method === "POST" && url.pathname === "/propose") {
        return send(res, 200, await node.acceptRemote(body as Envelope));
      }
      if (req.method === "POST" && url.pathname === "/commit") return send(res, 200, await node.commit());
      if (req.method === "POST" && url.pathname === "/abort") return send(res, 200, await node.abort());
      if (req.method === "POST" && url.pathname === "/sync") {
        if (!leaderUrl) return send(res, 200, { ok: true, code: "leader" });
        const ok = await node.syncFrom(leaderUrl);
        return send(res, ok ? 200 : 503, { ok, code: ok ? "accepted" : "fail-closed" });
      }
      if (req.method === "POST" && url.pathname === "/client/append") {
        const payloadText = body && typeof body === "object" ? (body as { payload?: unknown }).payload : undefined;
        if (typeof payloadText !== "string") return send(res, 400, { ok: false, code: "empty" });
        const result = await replicate(node, peers, () => node.stageData(Buffer.from(payloadText, "utf8")));
        return send(res, result.ok ? 201 : 409, result);
      }
      if (req.method === "POST" && url.pathname === "/client/prune") {
        const index = body && typeof body === "object" ? (body as { index?: unknown }).index : undefined;
        if (typeof index !== "number" || !Number.isInteger(index)) return send(res, 400, { ok: false, code: "missing" });
        const result = await replicate(node, peers, () => node.stagePrune(index));
        return send(res, result.ok ? 200 : 409, result);
      }
      return send(res, 404, { ok: false, code: "missing" });
    } catch (err) {
      const code = err instanceof ChainError ? err.code : "rejected";
      return send(res, 400, { ok: false, code });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function parsePeers(raw: string): Peer[] {
  if (!raw.trim()) return [];
  return raw.split(",").filter(Boolean).map((item) => {
    const eq = item.indexOf("=");
    const id = item.slice(0, eq);
    const base = item.slice(eq + 1);
    return {
      id,
      propose: (envelope) => postJson(`${base}/propose`, envelope) as Promise<Ack>,
      commit: () => postJson(`${base}/commit`, {}) as Promise<Ack>,
      abort: () => postJson(`${base}/abort`, {}) as Promise<Ack>,
    };
  });
}

async function atomicWrite(path: string, data: Buffer | string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const handle = await open(tmp, "w", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.length,
    "cache-control": "no-store",
  });
  res.end(encoded);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 32_000) throw new ChainError("too-large");
    chunks.push(buf);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ChainError("tamper");
  }
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  const text = await response.text();
  if (!text) return { ok: response.ok, code: response.ok ? "accepted" : "rejected" };
  return JSON.parse(text) as unknown;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new ChainError("unreachable");
  return JSON.parse(await response.text()) as unknown;
}

async function waitHealthy(url: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    try {
      await getJson(`${url}/health`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new ChainError("unreachable");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNet();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
if (isMain) {
  const command = process.env.CHAIN_COMMAND ?? "node";
  if (command === "init") {
    const root = process.env.DATA_DIR;
    if (!root) throw new ChainError("missing");
    await ensureLayout(join(root, "chain"));
    process.stdout.write("ready\n");
  } else if (command === "cluster") {
    const root = process.env.DATA_DIR;
    if (!root) throw new ChainError("missing");
    const cluster = await startCluster(root);
    process.stdout.write(`${JSON.stringify({ ports: cluster.ports })}\n`);
    const stop = () => {
      void cluster.stop().then(() => process.exit(0));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } else {
    await runNodeProcess();
  }
}
