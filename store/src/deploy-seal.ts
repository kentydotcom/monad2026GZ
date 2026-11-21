import { mkdir, writeFile } from "node:fs/promises";
import { Chain, MONAD_TESTNET_CHAIN_ID } from "./chain.js";

const EXPECTED_SIGNER = (process.env.WYRVEL_SIGNER ?? "0xD3Cea1317b62cB5C0CDe7e8a98cD80bBA2DC671e").toLowerCase();
const PRIMARY = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const BACKUP = process.env.RPC_URL_BACKUP ?? "https://rpc-testnet.monadinfra.com";

const privateKey = process.env.PRIVATE_KEY?.trim() ?? "";
if (!privateKey) {
  console.error("PRIVATE_KEY is not set. Refusing to deploy. No transaction was sent.");
  process.exit(1);
}

const rpc = await firstReachableRpc();
const chain = new Chain(rpc, privateKey, null);
await chain.loadArtifact();
await chain.refresh();
if (chain.chainError || chain.chainId === null) {
  console.error(chain.chainError ?? "Monad RPC is unreachable. No transaction was sent.");
  process.exit(1);
}
if (chain.chainId !== MONAD_TESTNET_CHAIN_ID) {
  console.error(`Expected chain id ${MONAD_TESTNET_CHAIN_ID}, got ${chain.chainId}. No transaction was sent.`);
  process.exit(1);
}

const signer = chain.signerAddress();
if (!signer || signer.toLowerCase() !== EXPECTED_SIGNER) {
  console.error(`Signer ${signer ?? "unknown"} is not the expected testnet account ${EXPECTED_SIGNER}. No transaction was sent.`);
  process.exit(1);
}

const balance = await chain.balanceOf(signer);
console.log(JSON.stringify({ signer, chainId: chain.chainId, balanceWei: balance.toString(), rpc }));
if (balance === 0n) {
  console.error("Signer balance is zero. No transaction was sent.");
  process.exit(1);
}

const deployed = await chain.deploy();
const outDir = "deploy-out";
await mkdir(outDir, { recursive: true });
await writeFile(
  `${outDir}/seal-address.txt`,
  `${deployed.address}\n`,
  "utf8",
);
const links = chain.linksFor(deployed.txHash);
console.log(
  JSON.stringify({
    deployed: deployed.address,
    txHash: deployed.txHash,
    gasEstimate: deployed.gasEstimate.toString(),
    gasLimit: deployed.gasLimit.toString(),
    explorer: links.explorer,
  }),
);
console.log("Gas was estimated before the deploy transaction was broadcast.");
console.log("");
console.log("Create the Fly app, the data volume, then inject secrets on this machine. Do not paste the key into a file in the repo.");
console.log("fly apps create wyrvel-blitz");
console.log("fly volumes create wyrvel_data --region sin --size 1 --app wyrvel-blitz");
console.log(
  `fly secrets set --app wyrvel-blitz PRIVATE_KEY="$PRIVATE_KEY" WYRVEL_GATE_PASSWORD="$WYRVEL_GATE_PASSWORD" WYRVEL_CONTRACT=${deployed.address} RPC_URL=${rpc}`,
);
console.log("fly deploy --app wyrvel-blitz --region sin");
console.log("The HTTP username is kent. The password is whatever this machine exports as WYRVEL_GATE_PASSWORD.");

async function firstReachableRpc(): Promise<string> {
  for (const url of [PRIMARY, BACKUP]) {
    const probe = new Chain(url, null, null);
    await probe.refresh();
    if (!probe.chainError && probe.chainId !== null) {
      probe.close();
      if (url !== PRIMARY) console.log(`Primary RPC did not answer. Using ${url}`);
      return url;
    }
    probe.close();
  }
  console.error(`Monad RPC is unreachable. Tried ${PRIMARY} and ${BACKUP}. No transaction was sent.`);
  process.exit(1);
}
