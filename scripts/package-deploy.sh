#!/usr/bin/env bash
# Build a deploy bundle in the agent store. The signing key is not included.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$PATH:${HOME}/.foundry/bin"
DEST="${WYRVEL_STORE_DIR:-/cursor/stores/self/deploy}"

cd "$ROOT"
forge build
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const artifact = JSON.parse(readFileSync("out/WyrvelSeal.sol/WyrvelSeal.json", "utf8"));
const slim = {
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
};
writeFileSync("store/src/artifact.json", JSON.stringify(slim));
'
npm run build --prefix web

mkdir -p "$DEST"
tar --exclude-vcs \
  --exclude node_modules \
  --exclude "*/node_modules" \
  --exclude "*/node_modules/*" \
  --exclude .secrets \
  --exclude ".secrets/*" \
  --exclude .env \
  --exclude ".env.local" \
  --exclude ".env.*.local" \
  --exclude cache \
  --exclude broadcast \
  --exclude .e2e \
  --exclude screenshots \
  --exclude store/data \
  --exclude deploy-out \
  --exclude "*.log" \
  --exclude "lib/forge-std/test" \
  --exclude "lib/forge-std/test/*" \
  -czf "$DEST/wyrvel-source.tar.gz" \
  -C "$ROOT" \
  .

cp "$ROOT/store/src/artifact.json" "$DEST/WyrvelSeal.json"
cat >"$DEST/DEPLOY.txt" <<'EOF'
WYRVEL deploy bundle

Copy these files off the agent store. Do not clone the git repo for the deploy.
The signing key is not in this bundle. Export PRIVATE_KEY on the machine that holds it.
The HTTP username is kent. Export WYRVEL_GATE_PASSWORD on that same machine.
Expected testnet signer: 0xD3Cea1317b62cB5C0CDe7e8a98cD80bBA2DC671e

1. Unpack wyrvel-source.tar.gz
2. npm ci --prefix store
3. npm run deploy-seal --prefix store
   This estimates gas, then broadcasts the seal to Monad testnet.
4. fly apps create wyrvel-blitz
5. fly volumes create wyrvel_data --region sin --size 1 --app wyrvel-blitz
6. fly secrets set --app wyrvel-blitz \
     PRIVATE_KEY="$PRIVATE_KEY" \
     WYRVEL_GATE_PASSWORD="$WYRVEL_GATE_PASSWORD" \
     WYRVEL_CONTRACT=<address printed by deploy-seal> \
     RPC_URL=https://testnet-rpc.monad.xyz
7. fly deploy --app wyrvel-blitz --region sin

The volume is mounted at /data. Without it, the team store does not survive a restart.
Erase removes only that team copy. The Monad seal stays.

Private chain
  fly.toml sets WYRVEL_CHAIN=1. That starts three extra processes on the same
  512 MB machine: one leader and two replicas. They are not BFT and they are
  not separate failure domains. Measured proportional memory is about 50 MB
  for the store plus about 130 MB for the three processes.
  Their files are created under /data/chain/ only.
  Do not delete /data, /data/index.json, or /data/payloads.
  Rollback: redeploy with WYRVEL_CHAIN unset or set to 0. Leave the volume.
  Do not run fly volumes destroy. Do not change the seal contract or the secrets.
  ./scripts/pchain-e2e.sh --ci runs the isolated checks and does not contact Monad.

Private-chain Monad anchor
  Existing WyrvelSeal.commit(recordId, commitment). ABI unchanged.
  recordId = keccak256(utf8(
    WYRVEL/private-record/v1
    chain wyrvel-private
    index <n>
    kind data|prune
    header <sha256 hex of the private header>
  ))
  commitment = keccak256(utf8(
    WYRVEL/private-anchor/v1
    chain wyrvel-private
    index <n>
    kind data|prune
    header <sha256 hex>
    target <index or ->
    targetHeader <sha256 hex or ->
  ))
  Lines are joined with newline. Header hashes are lowercase.
  Only those hashes are pinned. The payload is not.
  A confirmed anchor is a seal read-back match after an execution receipt.
  It is not finality and not proof the body is gone.
  Startup reconciles pending receipts and does not send.
  New append and prune try to anchor. If the send fails, the local prune stays
  and the anchor is pending or failed.
  Old blocks are anchored only from the Anchor block / Anchor audit buttons.
  State file: /data/chain/anchors.json. Do not delete the volume.
EOF
(
  cd "$DEST"
  sha256sum wyrvel-source.tar.gz WyrvelSeal.json > SHA256SUMS
)

python3 - <<PY
import tarfile
bad = []
with tarfile.open("$DEST/wyrvel-source.tar.gz") as tar:
    names = tar.getnames()
    for name in names:
        parts = [part for part in name.split("/") if part not in ("", ".")]
        if any(part in {".git", ".secrets", "node_modules", "cache", "broadcast"} for part in parts):
            bad.append(name)
        elif parts and parts[-1] in {".env", ".env.local"}:
            bad.append(name)
        elif "forge-std/test" in name:
            bad.append(name)
if bad:
    raise SystemExit("bundle contains excluded paths:\\n" + "\\n".join(bad[:20]))
print("bundle entries", len(names))
PY

python3 - <<PY
import re, pathlib
blob = pathlib.Path("$DEST/wyrvel-source.tar.gz").read_bytes()
if re.search(br"PRIVATE_KEY\s*=\s*['\"]?0x[0-9a-fA-F]{64}", blob):
    raise SystemExit("bundle assigns a signing key")
PY

echo "Wrote $DEST/wyrvel-source.tar.gz"
echo "Wrote $DEST/WyrvelSeal.json"
echo "Wrote $DEST/SHA256SUMS"
