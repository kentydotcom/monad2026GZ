#!/usr/bin/env bash
# WYRVEL end-to-end: commit, erase, check.
#
# The script walks the Saturday path and explains each step in the comments
# below. The Judge Tour E2E tabs match these six steps.
#
#   ./scripts/e2e.sh            interactive menu
#   ./scripts/e2e.sh --local    anvil --network monad; this script starts and stops it
#   ./scripts/e2e.sh --ci       official Monad testnet; skips if PRIVATE_KEY is unset
#   ./scripts/e2e.sh --step N   one step, using the current RPC, store, and .e2e state
#
# Hash: keccak256 of the UTF-8 payload, everywhere.
# Chain id 10143 is Monad testnet. Only that chain gets a public explorer link.
# The private key is read from the environment. --local reads Anvil account 0
# from Anvil's own startup log and does not keep a key in this file.

set -euo pipefail
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$PATH:${HOME}/.foundry/bin"
STATE_DIR="${WYRVEL_STATE_DIR:-$ROOT/.e2e}"
STATE_FILE="$STATE_DIR/state.env"
RPC_URL="${RPC_URL:-https://testnet-rpc.monad.xyz}"
RPC_URL_BACKUP="${RPC_URL_BACKUP:-https://rpc-testnet.monadinfra.com}"
STORE_URL="${STORE_URL:-http://127.0.0.1:8787}"
STORE_PORT="${STORE_PORT:-8787}"
ANVIL_PORT="${ANVIL_PORT:-8545}"
PAYLOAD_TEXT="WYRVEL keeps this sentence private until erase."

MODE="menu"
STEP=""
ANVIL_PID=""
STORE_PID=""
DATA_DIR="${DATA_DIR:-}"
STARTED_DATA=""
CHAIN_ID=""
CONTRACT="${WYRVEL_CONTRACT:-}"
RECORD_ID=""
COMMITMENT=""
TX_HASH=""
PINNED_AT=""
PINNER=""
PAYLOAD=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/e2e.sh
  ./scripts/e2e.sh --local
  ./scripts/e2e.sh --ci
  ./scripts/e2e.sh --step N

--local  Start anvil --network monad, deploy, run all six steps, then stop Anvil.
--ci     Run all six steps on Monad testnet. If PRIVATE_KEY is unset, skip and exit 0.
--step   Run one step against the RPC and store already in the environment.
EOF
}

say() { printf '\n%s\n' "$*"; }
ok() { printf '  ok  %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

mkdir -p "$STATE_DIR"

save_state() {
  mkdir -p "$STATE_DIR"
  local b64=""
  if [[ -n "$PAYLOAD" ]]; then
    b64="$(printf '%s' "$PAYLOAD" | base64 -w0)"
  fi
  cat >"$STATE_FILE" <<EOF
CONTRACT=${CONTRACT}
RECORD_ID=${RECORD_ID}
COMMITMENT=${COMMITMENT}
TX_HASH=${TX_HASH}
PINNED_AT=${PINNED_AT}
PINNER=${PINNER}
PAYLOAD_B64=${b64}
EOF
}

load_state() {
  [[ -f "$STATE_FILE" ]] || return 0
  CONTRACT="${CONTRACT:-$(awk -F= '/^CONTRACT=/{print substr($0,10)}' "$STATE_FILE")}"
  RECORD_ID="$(awk -F= '/^RECORD_ID=/{print substr($0,11)}' "$STATE_FILE")"
  COMMITMENT="$(awk -F= '/^COMMITMENT=/{print substr($0,12)}' "$STATE_FILE")"
  TX_HASH="$(awk -F= '/^TX_HASH=/{print substr($0,9)}' "$STATE_FILE")"
  PINNED_AT="$(awk -F= '/^PINNED_AT=/{print substr($0,11)}' "$STATE_FILE")"
  PINNER="$(awk -F= '/^PINNER=/{print substr($0,8)}' "$STATE_FILE")"
  local b64
  b64="$(awk -F= '/^PAYLOAD_B64=/{print substr($0,13)}' "$STATE_FILE")"
  if [[ -n "$b64" ]]; then
    PAYLOAD="$(printf '%s' "$b64" | base64 -d)"
  fi
}

json_get() {
  # Read a dotted path from a JSON document on stdin. Null prints as an empty line.
  python3 -c 'import json,sys
data=json.load(sys.stdin)
cur=data
for part in sys.argv[1].split("."):
    if not isinstance(cur, dict) or part not in cur:
        cur=None
        break
    cur=cur[part]
if isinstance(cur, bool):
    print("true" if cur else "false")
elif cur is None:
    print("")
else:
    print(cur)' "$1"
}

port_open() {
  curl -sf -m 1 -o /dev/null -X POST "http://127.0.0.1:$1" \
    -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
}

cleanup() {
  local status=$?
  if [[ -n "$STORE_PID" ]]; then
    kill -- "-$STORE_PID" >/dev/null 2>&1 || kill "$STORE_PID" >/dev/null 2>&1 || true
    wait "$STORE_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$ANVIL_PID" ]]; then
    kill "$ANVIL_PID" >/dev/null 2>&1 || true
    wait "$ANVIL_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$status" -eq 0 && -n "$STARTED_DATA" ]]; then
    rm -rf "$STARTED_DATA"
  elif [[ -n "$STARTED_DATA" ]]; then
    printf 'Store data left at %s\n' "$STARTED_DATA" >&2
  fi
}

# ---------------------------------------------------------------------------
# Step 1. Deploy or locate the seal contract.
#
# What it does: confirm the RPC answers and read the chain id. If
# WYRVEL_CONTRACT is set, read the bytecode at that address and use it.
# Otherwise deploy WyrvelSeal with the key in the environment and record the
# new address. The contract stores a 32-byte hash under a record id and emits
# Committed. It does not store a payload.
#
# Success: a contract address whose code is present on the chain that
# answered. If the RPC does not answer, the step stops with that error.
# ---------------------------------------------------------------------------
step_deploy() {
  say "Step 1 — Deploy or locate the seal contract"
  need cast
  if ! CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL" 2>"$STATE_DIR/rpc.err")"; then
    die "RPC $RPC_URL is unreachable. $(tr '\n' ' ' <"$STATE_DIR/rpc.err")"
  fi
  ok "Chain id $CHAIN_ID at $RPC_URL"
  if [[ "$MODE" == "ci" && "$CHAIN_ID" != "10143" ]]; then
    die "Expected Monad testnet chain id 10143, got $CHAIN_ID."
  fi
  if [[ -n "$CONTRACT" ]]; then
    local code
    code="$(cast code "$CONTRACT" --rpc-url "$RPC_URL")"
    if [[ -z "$code" || "$code" == "0x" ]]; then
      die "No contract code at $CONTRACT."
    fi
    ok "Located seal $CONTRACT"
    ok "Bytecode is present. No new deploy transaction was sent."
  else
    need forge
    [[ -n "${PRIVATE_KEY:-}" ]] || die "PRIVATE_KEY is not set, so the seal cannot be deployed."
    say "  Deploying WyrvelSeal with forge script."
    estimate_deploy
    (
      cd "$ROOT"
      forge script script/Deploy.s.sol:Deploy \
        --rpc-url "$RPC_URL" \
        --broadcast \
        --non-interactive \
        >"$STATE_DIR/deploy.log" 2>&1
    ) || {
      grep -v -E '0x[0-9a-fA-F]{64}' "$STATE_DIR/deploy.log" | tail -n 40 >&2 || true
      if grep -Eq "insufficient funds|intrinsic gas|gas required exceeds" "$STATE_DIR/deploy.log"; then
        die "Deploy failed. The account may not have enough testnet MON. Claim from https://faucet.monad.xyz and retry. See $STATE_DIR/deploy.log"
      fi
      die "Deploy failed. See $STATE_DIR/deploy.log"
    }
    local file="$ROOT/broadcast/Deploy.s.sol/${CHAIN_ID}/run-latest.json"
    [[ -f "$file" ]] || die "Broadcast file not found at $file"
    CONTRACT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["transactions"][-1]["contractAddress"])' "$file")"
    local code
    code="$(cast code "$CONTRACT" --rpc-url "$RPC_URL")"
    if [[ -z "$code" || "$code" == "0x" ]]; then
      die "Deployed address $CONTRACT has no code."
    fi
    ok "Deployed seal $CONTRACT"
  fi
  save_state
}

# ---------------------------------------------------------------------------
# Step 2. Commit a payload and pin its hash.
#
# What it does: write a short UTF-8 payload into the WYRVEL store under a new
# record id. The store computes keccak256 of those bytes and sends a
# transaction that pins the 32-byte hash. The payload is not part of the
# transaction. This step then asks the node for the transaction receipt.
#
# Success: a record id, the hash, a pin timestamp, and a mined transaction.
# On chain id 10143 the explorer URL is the official MonadVision transaction
# link. On any other chain the URL is empty. A missing or failed transaction
# is an error.
# ---------------------------------------------------------------------------
step_commit() {
  say "Step 2 — Commit a payload and pin its hash"
  need curl
  need cast
  [[ -n "$CONTRACT" ]] || die "Run step 1 first."
  PAYLOAD="$PAYLOAD_TEXT $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local body
  body="$(curl -sS -m 60 -X POST "$STORE_URL/v1/records" \
    -H 'content-type: application/json' \
    --data "$(PAYLOAD="$PAYLOAD" python3 -c 'import json,os; print(json.dumps({"payload": os.environ["PAYLOAD"]}))')")"
  local ok_flag
  ok_flag="$(printf '%s' "$body" | json_get ok || true)"
  if [[ "$ok_flag" != "true" ]]; then
    local err
    err="$(printf '%s' "$body" | json_get error || true)"
    die "Commit failed. ${err:-$body}"
  fi
  RECORD_ID="$(printf '%s' "$body" | json_get recordId)"
  COMMITMENT="$(printf '%s' "$body" | json_get commitment)"
  TX_HASH="$(printf '%s' "$body" | json_get pin.txHash)"
  PINNED_AT="$(printf '%s' "$body" | json_get pin.pinnedAt)"
  PINNER="$(printf '%s' "$body" | json_get pin.pinner)"
  local explorer chain_from_pin
  explorer="$(printf '%s' "$body" | json_get pin.explorer)"
  chain_from_pin="$(printf '%s' "$body" | json_get pin.chainId)"
  [[ "$RECORD_ID" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "Commit did not return a record id."
  [[ "$TX_HASH" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "Commit did not return a transaction hash."
  local receipt_status
  receipt_status="$(cast receipt "$TX_HASH" --rpc-url "$RPC_URL" --json | json_get status)"
  [[ "$receipt_status" == "0x1" || "$receipt_status" == "1" ]] || die "Transaction $TX_HASH was not successful."
  if [[ "$chain_from_pin" == "10143" ]]; then
    [[ "$explorer" == "https://testnet.monadvision.com/tx/$TX_HASH" ]] || die "Explorer link does not match the transaction."
    ok "Explorer $explorer"
  else
    [[ -z "$explorer" ]] || die "Refusing a public explorer link on chain $chain_from_pin."
    ok "No public explorer link on chain $chain_from_pin."
  fi
  ok "Record $RECORD_ID"
  ok "keccak256 $COMMITMENT"
  ok "Transaction $TX_HASH"
  save_state
}

# ---------------------------------------------------------------------------
# Step 3. Verify the payload matches the seal.
#
# What it does: read the payload back from the store, hash it with keccak256
# (cast keccak, independent of the store's own report), and read sealOf from
# the contract with cast. Compare the two hashes for this record id.
#
# Success: the store returns the original payload and the on-chain commitment
# equals that hash. This is the view from before erase.
# ---------------------------------------------------------------------------
step_match() {
  say "Step 3 — Verify the payload matches the seal"
  [[ -n "$RECORD_ID" ]] || die "Run step 2 first."
  local body got local_hash seal_json on_hash pinned
  body="$(curl -sS -m 30 "$STORE_URL/v1/records/$RECORD_ID")"
  got="$(printf '%s' "$body" | json_get payload)"
  [[ "$got" == "$PAYLOAD" ]] || die "Recovered payload does not match the committed text."
  local_hash="$(cast keccak "$got")"
  seal_json="$(cast call "$CONTRACT" "sealOf(bytes32)(bytes32,uint64,address,bool)" "$RECORD_ID" --rpc-url "$RPC_URL" --json)"
  on_hash="$(printf '%s' "$seal_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')"
  pinned="$(printf '%s' "$seal_json" | python3 -c 'import json,sys; print("true" if json.load(sys.stdin)[3] else "false")')"
  [[ "$pinned" == "true" ]] || die "The seal is not pinned."
  [[ "${local_hash,,}" == "${on_hash,,}" ]] || die "Payload hash $local_hash does not match seal $on_hash."
  [[ "${local_hash,,}" == "${COMMITMENT,,}" ]] || die "Store commitment does not match cast keccak."
  ok "Recovered payload hashes to the seal."
  ok "Record $RECORD_ID"
}

# ---------------------------------------------------------------------------
# Step 4. Erase the private copy.
#
# What it does: ask the WYRVEL store to erase the payload for the record id.
# The seal contract is not called. The sender nonce is read before and after
# so a transaction would be visible.
#
# Success: the store reports that the private copy is no longer held, and the
# pinner nonce is unchanged.
# ---------------------------------------------------------------------------
step_erase() {
  say "Step 4 — Erase the private copy"
  [[ -n "$RECORD_ID" && -n "$PINNER" ]] || die "Run step 2 first."
  local before after body flag
  before="$(cast nonce "$PINNER" --rpc-url "$RPC_URL")"
  body="$(curl -sS -m 30 -X POST "$STORE_URL/v1/records/$RECORD_ID/erase")"
  flag="$(printf '%s' "$body" | json_get recoverable || true)"
  [[ "$flag" == "false" ]] || die "Erase did not report the payload as unrecoverable. $body"
  after="$(cast nonce "$PINNER" --rpc-url "$RPC_URL")"
  [[ "$before" == "$after" ]] || die "Erase changed the pinner nonce, so a transaction was sent."
  ok "Private copy removed for $RECORD_ID"
  ok "Pinner nonce unchanged at $after. The seal transaction was not repeated."
  ok "Earlier transaction remains $TX_HASH"
}

# ---------------------------------------------------------------------------
# Step 5. Verify the payload is unrecoverable.
#
# What it does: ask the store for the same record id, as a checker would, and
# search the store data directory for the payload text.
#
# Success: the read does not return the payload (HTTP 410) and the directory
# does not contain that text.
# ---------------------------------------------------------------------------
step_gone() {
  say "Step 5 — Verify the payload is unrecoverable"
  [[ -n "$RECORD_ID" && -n "$PAYLOAD" ]] || die "Run step 2 first."
  [[ -n "$DATA_DIR" && -d "$DATA_DIR" ]] || die "DATA_DIR is not set, so the store directory cannot be checked."
  local tmp status body flag
  tmp="$(mktemp)"
  status="$(curl -sS -m 30 -o "$tmp" -w '%{http_code}' "$STORE_URL/v1/records/$RECORD_ID")"
  body="$(cat "$tmp")"
  rm -f "$tmp"
  [[ "$status" == "410" ]] || die "Expected HTTP 410 from the store, got $status. $body"
  flag="$(printf '%s' "$body" | json_get recoverable || true)"
  [[ "$flag" == "false" ]] || die "The store still marks the payload recoverable."
  if grep -R -a -F -q -- "$PAYLOAD" "$DATA_DIR"; then
    die "The store directory still contains the payload."
  fi
  ok "Read returned no payload."
  ok "Store directory does not contain the payload text."
  local kept="$PAYLOAD"
  PAYLOAD=""
  save_state
  PAYLOAD="$kept"
}

# ---------------------------------------------------------------------------
# Step 6. Verify the on-chain seal is unchanged.
#
# What it does: call sealOf again for the same record id and compare the
# commitment, the pinner, and the pin timestamp with the values saved at
# commit. Also confirm the original transaction receipt is still successful.
#
# Success: the seal fields match the commit, and the payload remains
# unrecoverable.
# ---------------------------------------------------------------------------
step_seal() {
  say "Step 6 — Verify the on-chain seal is unchanged"
  [[ -n "$RECORD_ID" && -n "$COMMITMENT" && -n "$PINNED_AT" && -n "$PINNER" ]] || die "Run step 2 first."
  local seal_json on_hash on_time on_pinner on_pinned receipt_status status
  seal_json="$(cast call "$CONTRACT" "sealOf(bytes32)(bytes32,uint64,address,bool)" "$RECORD_ID" --rpc-url "$RPC_URL" --json)"
  on_hash="$(printf '%s' "$seal_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')"
  on_time="$(printf '%s' "$seal_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)[1])')"
  on_pinner="$(printf '%s' "$seal_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)[2])')"
  on_pinned="$(printf '%s' "$seal_json" | python3 -c 'import json,sys; print("true" if json.load(sys.stdin)[3] else "false")')"
  [[ "$on_pinned" == "true" ]] || die "The seal is no longer pinned."
  [[ "${on_hash,,}" == "${COMMITMENT,,}" ]] || die "Commitment changed."
  [[ "$on_time" == "$PINNED_AT" ]] || die "Pin timestamp changed ($on_time vs $PINNED_AT)."
  [[ "${on_pinner,,}" == "${PINNER,,}" ]] || die "Pinner changed."
  receipt_status="$(cast receipt "$TX_HASH" --rpc-url "$RPC_URL" --json | json_get status)"
  [[ "$receipt_status" == "0x1" || "$receipt_status" == "1" ]] || die "Original transaction is no longer successful."
  status="$(curl -sS -m 30 -o /dev/null -w '%{http_code}' "$STORE_URL/v1/records/$RECORD_ID")"
  [[ "$status" == "410" ]] || die "The payload became recoverable again (HTTP $status)."
  ok "Commitment, timestamp, and pinner match the commit."
  ok "Transaction $TX_HASH is unchanged."
  ok "The payload is still unrecoverable."
}

run_all() {
  step_deploy
  step_commit
  step_match
  step_erase
  step_gone
  step_seal
  say "All six steps passed."
}

start_anvil() {
  need anvil
  if port_open "$ANVIL_PORT"; then
    die "Port $ANVIL_PORT is already in use. Stop that node before --local."
  fi
  anvil --network monad --host 127.0.0.1 --port "$ANVIL_PORT" >"$STATE_DIR/anvil.log" 2>&1 &
  ANVIL_PID=$!
  local _i
  for _i in $(seq 1 50); do
    if cast chain-id --rpc-url "http://127.0.0.1:$ANVIL_PORT" >/dev/null 2>&1; then
      RPC_URL="http://127.0.0.1:$ANVIL_PORT"
      ok "Anvil is up with --network monad on port $ANVIL_PORT."
      return
    fi
    sleep 0.1
  done
  grep -v -E '0x[0-9a-fA-F]{64}' "$STATE_DIR/anvil.log" | tail -n 20 >&2 || true
  die "Anvil did not become ready."
}

# Account 0 is printed by Anvil itself. It stays in this process and is not written back to the repo.
read_anvil_key() {
  local log="$1"
  local key=""
  key="$(awk 'f && $1 == "(0)" { print $2; exit } /Private Keys/ { f = 1 }' "$log")"
  if [[ ! "$key" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
    die "Anvil did not publish account 0. The local deploy was not broadcast."
  fi
  export PRIVATE_KEY="$key"
}

estimate_deploy() {
  local from="" bytecode="" est=""
  from="$(
    cd "$ROOT/store"
    node --input-type=module -e 'import {Wallet} from "ethers"; const k=process.env.PRIVATE_KEY??""; if(!k) process.exit(1); process.stdout.write(new Wallet(k).address);'
  )"
  bytecode="$(python3 -c 'import json,sys; b=json.load(open(sys.argv[1]))["bytecode"]; print(b if str(b).startswith("0x") else "0x"+b)' "$ROOT/store/src/artifact.json")"
  if ! est="$(cast estimate --rpc-url "$RPC_URL" --from "$from" --create "$bytecode" 2>"$STATE_DIR/estimate.err")"; then
    grep -v -E '0x[0-9a-fA-F]{64}' "$STATE_DIR/estimate.err" >&2 || true
    die "Gas estimate failed. The deploy was not broadcast."
  fi
  [[ "$est" =~ ^[0-9]+$ ]] || die "Gas estimate was not a number. The deploy was not broadcast."
  ok "Gas estimate for the seal deploy is ${est}. Broadcasting only after that estimate."
}

start_store() {
  need node
  need npm
  [[ -d "$ROOT/store/node_modules/ethers" ]] || die "Install store dependencies first: npm install --prefix store"
  if curl -sf -m 1 "$STORE_URL/v1/health" >/dev/null 2>&1; then
    die "A store is already listening at $STORE_URL. Stop it before --local."
  fi
  DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wyrvel-store.XXXXXX")"
  STARTED_DATA="$DATA_DIR"
  (
    cd "$ROOT/store"
    HOST=127.0.0.1 \
      PORT="$STORE_PORT" \
      DATA_DIR="$DATA_DIR" \
      RPC_URL="$RPC_URL" \
      PRIVATE_KEY="$PRIVATE_KEY" \
      WYRVEL_CONTRACT="$CONTRACT" \
      npm run start --silent
  ) >"$STATE_DIR/store.log" 2>&1 &
  STORE_PID=$!
  # The subshell is the process-group leader when monitor mode is on.
  STORE_URL="http://127.0.0.1:$STORE_PORT"
  local _i
  for _i in $(seq 1 50); do
    if curl -sf -m 1 "$STORE_URL/v1/health" >/dev/null 2>&1; then
      ok "Store is up at $STORE_URL"
      return
    fi
    sleep 0.1
  done
  tail -n 40 "$STATE_DIR/store.log" >&2 || true
  die "Store did not become ready."
}

pick_testnet_rpc() {
  local err="$STATE_DIR/rpc.err"
  if CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL" 2>"$err")"; then
    ok "Using $RPC_URL"
    return
  fi
  if CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL_BACKUP" 2>>"$err")"; then
    RPC_URL="$RPC_URL_BACKUP"
    ok "Primary RPC failed. Using backup $RPC_URL"
    return
  fi
  die "Monad testnet RPC is unreachable. Tried ${RPC_URL} and ${RPC_URL_BACKUP}."
}

credentials_present() {
  local key="${PRIVATE_KEY:-}"
  key="${key//[[:space:]]/}"
  [[ -n "$key" ]]
}

summarize_success() {
  local label="$1"
  if [[ -z "$CONTRACT" || -z "$TX_HASH" || -z "$COMMITMENT" || -z "$RECORD_ID" || -z "$CHAIN_ID" ]]; then
    die "Refusing a silent success. Deploy, commit, and the seal check did not all produce results."
  fi
  cat <<EOF

WYRVEL e2e ${label} passed.
All six steps ran on chain ${CHAIN_ID}. This is not a skipped run.
1 deploy or locate    ${CONTRACT}
2 commit transaction  ${TX_HASH}
3 payload matches the seal for ${RECORD_ID}
4 erase sent no transaction
5 team-store copy is unrecoverable
6 seal unchanged      ${COMMITMENT}

EOF
}

prepare_ci() {
  if ! credentials_present; then
    cat <<'EOF'
WYRVEL e2e --ci skipped: PRIVATE_KEY is not set.

Export PRIVATE_KEY for a Monad testnet account that holds testnet MON, then run:
  ./scripts/e2e.sh --ci

No transaction was sent.
EOF
    exit 0
  fi
  PRIVATE_KEY="${PRIVATE_KEY//[[:space:]]/}"
  export PRIVATE_KEY
  need cast
  need forge
  need curl
  pick_testnet_rpc
  if [[ "$CHAIN_ID" != "10143" ]]; then
    die "Expected Monad testnet chain id 10143, got $CHAIN_ID."
  fi
  rm -f "$STATE_FILE"
  RECORD_ID=""
  COMMITMENT=""
  TX_HASH=""
  PINNED_AT=""
  PINNER=""
  PAYLOAD=""
  step_deploy
  start_store
}

prepare_local() {
  need cast
  need forge
  need curl
  need node
  CONTRACT=""
  start_anvil
  read_anvil_key "$STATE_DIR/anvil.log"
  step_deploy
  start_store
}

menu() {
  local choice
  while true; do
    cat <<EOF

WYRVEL · commit, erase, check
Hash keccak256. Chain ${CHAIN_ID:-unknown}. Store ${STORE_URL}.
Seal ${CONTRACT:-not deployed yet}.

  1  Deploy or locate the seal contract
  2  Commit a payload and pin its hash
  3  Verify the payload matches the seal
  4  Erase the private copy
  5  Verify the payload is unrecoverable
  6  Verify the on-chain seal is unchanged
  a  Run all six steps
  p  Private chain checks
  q  Quit

EOF
    printf 'Choose a step: '
    IFS= read -r choice || exit 0
    case "$choice" in
      1) step_deploy ;;
      2) step_commit ;;
      3) step_match ;;
      4) step_erase ;;
      5) step_gone ;;
      6) step_seal ;;
      a) run_all ;;
      p) "$ROOT/scripts/pchain-e2e.sh" ;;
      q) say "Stopped."; exit 0 ;;
      *) printf 'Enter 1-6, a, p, or q.\n' ;;
    esac
  done
}

choose_target() {
  cat <<'EOF'

Where should this run?

  1  Local Anvil. This script starts and stops anvil --network monad.
  2  Monad testnet. Uses PRIVATE_KEY and the official RPC.
  q  Quit

EOF
  local choice
  printf 'Choose a target: '
  IFS= read -r choice || exit 0
  case "$choice" in
    1) MODE="local"; prepare_local ;;
    2)
      MODE="ci"
      if [[ -z "${PRIVATE_KEY:-}" ]]; then
        die "PRIVATE_KEY is not set."
      fi
      prepare_ci
      ;;
    q) exit 0 ;;
    *) die "Enter 1, 2, or q." ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) MODE="local" ;;
    --ci) MODE="ci" ;;
    --step)
      MODE="step"
      STEP="${2:-}"
      [[ "$STEP" =~ ^[1-6]$ ]] || die "--step needs a number from 1 to 6."
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
  shift
done

trap cleanup EXIT

case "$MODE" in
  local)
    prepare_local
    step_commit
    step_match
    step_erase
    step_gone
    step_seal
    summarize_success "local"
    ;;
  ci)
    prepare_ci
    # Step 1 already ran inside prepare_ci, against the live RPC, before the store started.
    step_commit
    step_match
    step_erase
    step_gone
    step_seal
    summarize_success "ci"
    ;;
  step)
    load_state
    [[ -n "${PRIVATE_KEY:-}" ]] || die "PRIVATE_KEY is not set."
    case "$STEP" in
      1) step_deploy ;;
      2) step_commit ;;
      3) step_match ;;
      4) step_erase ;;
      5) step_gone ;;
      6) step_seal ;;
    esac
    ;;
  menu)
    if [[ ! -t 0 ]]; then
      usage
      die "No terminal attached. Use --local, --ci, or --step N."
    fi
    choose_target
    menu
    ;;
esac
