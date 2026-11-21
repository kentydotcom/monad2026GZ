import { randomBytes } from "node:crypto";
import { open, readFile, readdir, rename, unlink, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hexlify } from "ethers";
import { commitmentOf, isRecordId } from "./hash.js";

export type RecordMeta = {
  recordId: string;
  commitment: string;
  byteLength: number;
  storedAt: string;
  erasedAt: string | null;
  txHash: string | null;
  blockNumber: number | null;
  pinnedAt: number | null;
  pinner: string | null;
};

type IndexFile = {
  records: Record<string, RecordMeta>;
};

export type StoredPayload = {
  meta: RecordMeta | null;
  payload: string | null;
  recoverable: boolean;
};

/**
 * Private payload files for the team store.
 * Recovery follows the file on disk, not a status field.
 */
export class Vault {
  private index: IndexFile = { records: {} };
  private loaded = false;

  constructor(private readonly root: string) {}

  private indexPath(): string {
    return join(this.root, "index.json");
  }

  private payloadPath(recordId: string): string {
    if (!isRecordId(recordId)) {
      throw new Error("Record id must be a 32-byte hex value.");
    }
    return join(this.root, "payloads", recordId.slice(2).toLowerCase());
  }

  async load(): Promise<void> {
    await mkdir(join(this.root, "payloads"), { recursive: true });
    try {
      const raw = await readFile(this.indexPath(), "utf8");
      const parsed = JSON.parse(raw) as IndexFile;
      this.index = parsed?.records ? parsed : { records: {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.index = { records: {} };
    }
    this.loaded = true;
  }

  private async saveIndex(): Promise<void> {
    const path = this.indexPath();
    const tmp = `${path}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(this.index), "utf8");
    await rename(tmp, path);
  }

  async put(payload: string): Promise<RecordMeta> {
    if (!this.loaded) await this.load();
    const recordId = hexlify(randomBytes(32));
    const commitment = commitmentOf(payload);
    const bytes = Buffer.from(payload, "utf8");
    const meta: RecordMeta = {
      recordId,
      commitment,
      byteLength: bytes.length,
      storedAt: new Date().toISOString(),
      erasedAt: null,
      txHash: null,
      blockNumber: null,
      pinnedAt: null,
      pinner: null,
    };
    const path = this.payloadPath(recordId);
    await writeFile(path, bytes, { flag: "wx" });
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.index.records[recordId.toLowerCase()] = meta;
    await this.saveIndex();
    return meta;
  }

  async attachPin(
    recordId: string,
    pin: { txHash: string; blockNumber: number; pinnedAt: number; pinner: string },
  ): Promise<RecordMeta> {
    if (!this.loaded) await this.load();
    const key = recordId.toLowerCase();
    const current = this.index.records[key];
    if (!current) throw new Error("Record is not in the store.");
    const next: RecordMeta = { ...current, ...pin };
    this.index.records[key] = next;
    await this.saveIndex();
    return next;
  }

  async drop(recordId: string): Promise<void> {
    if (!this.loaded) await this.load();
    const key = recordId.toLowerCase();
    delete this.index.records[key];
    await this.saveIndex();
    await this.removeFile(recordId);
  }

  async read(recordId: string): Promise<StoredPayload> {
    if (!this.loaded) await this.load();
    if (!isRecordId(recordId)) {
      throw new Error("Record id must be a 32-byte hex value.");
    }
    const meta = this.index.records[recordId.toLowerCase()] ?? null;
    const path = this.payloadPath(recordId);
    try {
      const payload = await readFile(path, "utf8");
      return { meta, payload, recoverable: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return { meta, payload: null, recoverable: false };
    }
  }

  async erase(recordId: string): Promise<RecordMeta> {
    if (!this.loaded) await this.load();
    if (!isRecordId(recordId)) {
      throw new Error("Record id must be a 32-byte hex value.");
    }
    const key = recordId.toLowerCase();
    const current = this.index.records[key];
    if (!current) {
      throw new Error("No WYRVEL record for that id.");
    }
    const existing = await this.read(recordId);
    await this.removeFile(recordId);
    const still = await this.read(recordId);
    if (still.recoverable) {
      throw new Error("Erase failed. The stored copy is still present.");
    }
    const next: RecordMeta = {
      ...current,
      erasedAt: current.erasedAt ?? new Date().toISOString(),
    };
    this.index.records[key] = next;
    await this.saveIndex();
    if (existing.payload) {
      const ownFile = this.payloadPath(recordId);
      try {
        const buf = await readFile(ownFile);
        if (buf.includes(Buffer.from(existing.payload))) {
          throw new Error("Erase failed. The stored copy is still present.");
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return next;
  }

  async directoryHolds(snippet: string): Promise<boolean> {
    if (!snippet) return false;
    const files = await walk(this.root);
    const needle = Buffer.from(snippet);
    for (const file of files) {
      const buf = await readFile(file);
      if (buf.includes(needle)) return true;
    }
    return false;
  }

  private async removeFile(recordId: string): Promise<void> {
    const path = this.payloadPath(recordId);
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
        if (bytesWritten !== size) {
          throw new Error("Erase failed. The stored copy is still present.");
        }
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
    const leftover = await readFile(path);
    if (leftover.some((byte) => byte !== 0)) {
      throw new Error("Erase failed. The stored copy is still present.");
    }
    await unlink(path);
  }
}

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
