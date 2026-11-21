import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { authorizeBasic } from "./gate.js";
import { isAddress } from "./hash.js";
import { Service } from "./service.js";
import { errorText } from "./chain.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

export type PrivateChain = {
  topology(): Promise<Record<string, unknown>>;
  append(payload: string): Promise<Record<string, unknown>>;
  prune(index: number): Promise<Record<string, unknown>>;
  observe(index: number): Promise<Record<string, unknown>>;
};

export function startServer(options: {
  service: Service;
  host: string;
  port: number;
  staticDir: string | null;
  localAdmin: boolean;
  gatePassword?: string | null;
  privateChain?: PrivateChain | null;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const { service } = options;
  const gatePassword = options.gatePassword?.trim() ?? "";

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const openHealth = req.method === "GET" && url.pathname === "/v1/health";
      if (gatePassword && !openHealth && !authorizeBasic(req.headers.authorization, gatePassword)) {
        res.writeHead(401, {
          "www-authenticate": 'Basic realm="WYRVEL", charset="UTF-8"',
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        });
        res.end("Authentication required.");
        return;
      }
      if (url.pathname.startsWith("/v1/")) {
        await routeApi(req, res, url, service, options.localAdmin, options.privateChain ?? null);
        return;
      }
      if (options.staticDir && req.method === "GET") {
        const served = await serveStatic(options.staticDir, url.pathname, res);
        if (served) return;
      }
      sendJson(res, 404, { ok: false, error: "Not found." });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      sendJson(res, status, { ok: false, error: errorText(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({
        port,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function routeApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: Service,
  localAdmin: boolean,
  privateChain: PrivateChain | null,
): Promise<void> {
  if (req.method === "GET" && url.pathname === "/v1/health") {
    sendJson(res, 200, {
      ok: true,
      hash: "keccak256",
      chainId: service.chain.chainId,
      chainError: service.chain.chainError,
      contract: service.chain.contractAddress,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/meta") {
    await service.chain.refresh();
    const chainId = service.chain.chainId;
    sendJson(res, 200, {
      ok: true,
      hash: "keccak256",
      contract: service.chain.contractAddress,
      chainId,
      chainName: chainId === 10143 ? "Monad testnet" : chainId === null ? "Unreachable" : "Local chain",
      chainError: service.chain.chainError,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/records") {
    const body = await readJson(req);
    const payload = body && typeof body === "object" ? (body as { payload?: unknown }).payload : undefined;
    if (typeof payload !== "string") throw new HttpError(400, "Payload must be a string.");
    try {
      const result = await service.commitPayload(payload);
      sendJson(res, 201, result);
    } catch (err) {
      throw new HttpError(502, errorText(err));
    }
    return;
  }

  const recordMatch = url.pathname.match(/^\/v1\/records\/(0x[0-9a-fA-F]{64})$/);
  if (req.method === "GET" && recordMatch?.[1]) {
    const recordId = recordMatch[1];
    const stored = await service.readRecord(recordId);
    if (!stored.meta && !stored.recoverable) {
      sendJson(res, 404, { ok: false, recoverable: false, error: "No WYRVEL record for that id." });
      return;
    }
    if (!stored.recoverable) {
      sendJson(res, 410, {
        ok: false,
        recordId,
        commitment: stored.meta?.commitment ?? null,
        recoverable: false,
        erasedAt: stored.meta?.erasedAt ?? null,
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      recordId,
      commitment: stored.meta?.commitment ?? null,
      payload: stored.payload,
      recoverable: true,
      storedAt: stored.meta?.storedAt ?? null,
    });
    return;
  }

  const eraseMatch = url.pathname.match(/^\/v1\/records\/(0x[0-9a-fA-F]{64})\/erase$/);
  if (req.method === "POST" && eraseMatch?.[1]) {
    try {
      const meta = await service.eraseRecord(eraseMatch[1]);
      sendJson(res, 200, {
        ok: true,
        recordId: meta.recordId,
        recoverable: false,
        erasedAt: meta.erasedAt,
      });
    } catch (err) {
      const message = errorText(err);
      const status = message.includes("No WYRVEL record") ? 404 : 400;
      throw new HttpError(status, message);
    }
    return;
  }

  const checkMatch = url.pathname.match(/^\/v1\/check\/(0x[0-9a-fA-F]{64})$/);
  if (req.method === "GET" && checkMatch?.[1]) {
    const result = await service.checkRecord(checkMatch[1]);
    sendJson(res, result.ok ? 200 : 502, result);
    return;
  }

  const stepMatch = url.pathname.match(/^\/v1\/e2e\/steps\/([1-6])$/);
  if (req.method === "POST" && stepMatch?.[1]) {
    try {
      const step = Number(stepMatch[1]);
      const result = await service.runStep(step);
      sendJson(res, 200, { ok: true, step, ...result });
    } catch (err) {
      sendJson(res, 502, { ok: false, step: Number(stepMatch[1]), error: errorText(err), log: [] });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/contract") {
    if (!localAdmin) throw new HttpError(404, "Not found.");
    const body = await readJson(req);
    const address = body && typeof body === "object" ? (body as { address?: unknown }).address : undefined;
    if (typeof address !== "string" || !isAddress(address)) {
      throw new HttpError(400, "Address must be a 20-byte hex value.");
    }
    service.chain.contractAddress = address;
    service.e2e.contract = address;
    sendJson(res, 200, { ok: true, contract: address });
    return;
  }

  if (url.pathname.startsWith("/v1/pchain/")) {
    await routePrivateChain(req, res, url, privateChain);
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/e2e/state") {
    sendJson(res, 200, { ok: true, ...service.e2e });
    return;
  }

  if (url.pathname.startsWith("/v1/records/")) {
    throw new HttpError(400, "Record id must be a 32-byte hex value.");
  }

  sendJson(res, 404, { ok: false, error: "Not found." });
}

async function routePrivateChain(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  privateChain: PrivateChain | null,
): Promise<void> {
  if (!privateChain) {
    sendJson(res, 503, { ok: false, code: "not-running" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/pchain/topology") {
    sendJson(res, 200, await privateChain.topology());
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/pchain/append") {
    const body = await readJson(req);
    const payload = body && typeof body === "object" ? (body as { payload?: unknown }).payload : undefined;
    if (typeof payload !== "string") throw new HttpError(400, "Payload must be a string.");
    const result = await privateChain.append(payload);
    sendJson(res, result.ok === true ? 201 : 409, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/pchain/prune") {
    const body = await readJson(req);
    const index = body && typeof body === "object" ? (body as { index?: unknown }).index : undefined;
    if (typeof index !== "number" || !Number.isInteger(index)) throw new HttpError(400, "Block index must be an integer.");
    const result = await privateChain.prune(index);
    sendJson(res, result.ok === true ? 200 : 409, result);
    return;
  }
  const observe = url.pathname.match(/^\/v1\/pchain\/observe\/(\d+)$/);
  if (req.method === "GET" && observe?.[1]) {
    sendJson(res, 200, await privateChain.observe(Number(observe[1])));
    return;
  }
  sendJson(res, 404, { ok: false, code: "missing" });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 256_000) throw new HttpError(413, "Request body is too large.");
    chunks.push(buf);
  }
  if (total === 0) throw new HttpError(400, "Request body is required.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.length,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(encoded);
}

async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<boolean> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safe);
  if (!filePath.startsWith(root)) return false;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const type = TYPES[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": info.size,
      "cache-control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=300",
    });
    createReadStream(filePath).pipe(res);
    return true;
  } catch {
    if (pathname.startsWith("/v1/")) return false;
    try {
      const indexPath = join(root, "index.html");
      const info = await stat(indexPath);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": info.size,
        "cache-control": "no-cache",
      });
      createReadStream(indexPath).pipe(res);
      return true;
    } catch {
      return false;
    }
  }
}
