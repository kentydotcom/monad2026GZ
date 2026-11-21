import { resolve } from "node:path";
import { Chain } from "./chain.js";
import { ChainError, startCluster } from "./privatechain.js";
import { Service } from "./service.js";
import { startServer } from "./server.js";
import { Vault } from "./vault.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");
const dataDir = resolve(process.env.DATA_DIR ?? "data");
const rpcUrl = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const privateKey = blankToNull(process.env.PRIVATE_KEY);
const contract = blankToNull(process.env.WYRVEL_CONTRACT);
const staticDir = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;
const localAdmin = process.env.WYRVEL_LOCAL_ADMIN === "1";
const gatePassword = blankToNull(process.env.WYRVEL_GATE_PASSWORD);
const production = process.env.NODE_ENV === "production";

if (production && !gatePassword) {
  console.error(
    "WYRVEL_GATE_PASSWORD is required when NODE_ENV=production. The HTTP username is kent. Inject the password in the host environment. No password is stored in this image.",
  );
  process.exit(1);
}

const vault = new Vault(dataDir);
await vault.load();
const chain = new Chain(rpcUrl, privateKey, contract);
await chain.loadArtifact();
await chain.refresh();
const service = new Service(vault, chain);

let privateChain: Awaited<ReturnType<typeof startCluster>> | null = null;
if (process.env.WYRVEL_CHAIN === "1") {
  try {
    privateChain = await startCluster(dataDir);
  } catch (err) {
    console.error(JSON.stringify({ privateChain: err instanceof ChainError ? err.code : "unavailable" }));
  }
}

const server = await startServer({ service, host, port, staticDir, localAdmin, gatePassword, privateChain });
console.log(
  JSON.stringify({
    listening: `${host}:${server.port}`,
    chainId: chain.chainId,
    chainError: chain.chainError,
    contract: chain.contractAddress,
    hash: "keccak256",
    gate: gatePassword ? "on" : "off",
    privateChain: privateChain ? "up" : "off",
  }),
);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await privateChain?.stop();
  await server.close();
  process.exit(0);
}
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}
