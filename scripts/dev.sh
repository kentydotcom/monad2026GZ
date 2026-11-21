#!/usr/bin/env bash
# Start a local Judge Tour: Anvil with Monad execution, the seal, the store, and the site.
# Ctrl-C stops all three. Anvil account 0 is read from Anvil's log and is not stored here.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$PATH:$HOME/.foundry/bin"
PID_ANVIL=""
PID_STORE=""
PID_WEB=""
LOG="$ROOT/.e2e-dev-anvil.log"

cleanup() {
  [[ -n "$PID_WEB" ]] && kill "$PID_WEB" >/dev/null 2>&1 || true
  [[ -n "$PID_STORE" ]] && kill "$PID_STORE" >/dev/null 2>&1 || true
  [[ -n "$PID_ANVIL" ]] && kill "$PID_ANVIL" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if curl -sf -m 1 -o /dev/null -X POST http://127.0.0.1:8545 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'; then
  echo "Port 8545 is already in use." >&2
  exit 1
fi

anvil --network monad --host 127.0.0.1 --port 8545 >"$LOG" 2>&1 &
PID_ANVIL=$!
for _ in $(seq 1 50); do
  if cast chain-id --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

KEY="$(awk 'f && $1 == "(0)" { print $2; exit } /Private Keys/ { f = 1 }' "$LOG")"
if [[ ! "$KEY" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "Anvil did not publish account 0." >&2
  exit 1
fi
export PRIVATE_KEY="$KEY"

(
  cd "$ROOT"
  forge script script/Deploy.s.sol:Deploy \
    --rpc-url http://127.0.0.1:8545 --broadcast --non-interactive
)
CHAIN="$(cast chain-id --rpc-url http://127.0.0.1:8545)"
CONTRACT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["transactions"][-1]["contractAddress"])' "$ROOT/broadcast/Deploy.s.sol/${CHAIN}/run-latest.json")"
echo "Seal $CONTRACT on chain $CHAIN"

mkdir -p "$ROOT/store/data"
(
  cd "$ROOT/store"
  HOST=127.0.0.1 PORT=8787 DATA_DIR="$ROOT/store/data" \
    RPC_URL=http://127.0.0.1:8545 PRIVATE_KEY="$PRIVATE_KEY" \
    WYRVEL_CONTRACT="$CONTRACT" WYRVEL_LOCAL_ADMIN=1 \
    npm run start --silent
) &
PID_STORE=$!

for _ in $(seq 1 50); do
  if curl -sf -m 1 http://127.0.0.1:8787/v1/health >/dev/null; then
    break
  fi
  sleep 0.1
done

(
  cd "$ROOT/web"
  npm run dev -- --host 127.0.0.1 --port 5173
) &
PID_WEB=$!

echo "Judge Tour  http://127.0.0.1:5173"
echo "Store       http://127.0.0.1:8787"
wait "$PID_WEB"
