#!/usr/bin/env bash
# Private chain proof of concept.
# Three processes, leader ordered, not BFT. One machine is one failure domain.
# This does not send a Monad transaction and does not touch the team vault.
#
#   ./scripts/pchain-e2e.sh           interactive menu
#   ./scripts/pchain-e2e.sh --ci      run every check, then exit
#   ./scripts/pchain-e2e.sh --local   same checks on this machine
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_ENTRY="$ROOT/store/src/privatechain.ts"
export PAYLOAD="SYNTHETIC private-chain e2e. Not a real person. Staff id EX-0000."
MODE="menu"
DATA=""
LOG=""
LEADER_PORT=""
PORT_A=""
PORT_B=""
INDEX=""
HEADER=""
HEIGHT_AFTER_PRUNE=""
FAILS=0

usage() {
  cat <<'EOF'
Usage:
  ./scripts/pchain-e2e.sh
  ./scripts/pchain-e2e.sh --ci
  ./scripts/pchain-e2e.sh --local

--ci and --local both run the isolated process checks. Neither contacts Monad.
EOF
}

say() { printf '\n%s\n' "$*"; }
pass() { printf 'PASS  %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*" >&2; FAILS=$((FAILS + 1)); }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

now_ms() { python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
}

cleanup() {
  local id
  for id in leader replica-a replica-b; do
    if [[ -n "${DATA:-}" && -f "$DATA/$id.pid" ]]; then
      kill "$(cat "$DATA/$id.pid")" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

start_node() {
  local id="$1" port="$2"
  local leader_url="" peers=""
  if [[ "$id" != "leader" ]]; then
    leader_url="http://127.0.0.1:${LEADER_PORT}"
  else
    peers="replica-a=http://127.0.0.1:${PORT_A},replica-b=http://127.0.0.1:${PORT_B}"
  fi
  CHAIN_COMMAND=node \
    CHAIN_ID="$id" \
    CHAIN_DIR="$DATA/chain/nodes/$id" \
    CHAIN_MEMBERSHIP="$DATA/chain/membership.json" \
    CHAIN_PORT="$port" \
    CHAIN_LEADER_URL="$leader_url" \
    CHAIN_PEERS="$peers" \
    node --experimental-strip-types "$NODE_ENTRY" >>"$LOG" 2>&1 &
  echo $! >"$DATA/$id.pid"
}

wait_health() {
  local url="$1"
  local i
  for i in $(seq 1 40); do
    if curl -sf -m 1 "$url/health" >/dev/null; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}

boot() {
  need node
  need curl
  need python3
  DATA="$(mktemp -d "${TMPDIR:-/tmp}/wyrvel-pchain.XXXXXX")"
  LOG="$DATA/node.log"
  touch "$LOG"
  printf 'vault-must-stay\n' >"$DATA/index.json"
  mkdir -p "$DATA/payloads"
  printf 'vault-must-stay\n' >"$DATA/payloads/keep"
  DATA_DIR="$DATA" CHAIN_COMMAND=init node --experimental-strip-types "$NODE_ENTRY" >/dev/null
  LEADER_PORT="$(free_port)"
  PORT_A="$(free_port)"
  PORT_B="$(free_port)"
  start_node leader "$LEADER_PORT"
  wait_health "http://127.0.0.1:${LEADER_PORT}" || die "Leader did not start."
  start_node replica-a "$PORT_A"
  start_node replica-b "$PORT_B"
  wait_health "http://127.0.0.1:${PORT_A}" || die "Replica A did not start."
  wait_health "http://127.0.0.1:${PORT_B}" || die "Replica B did not start."
  curl -sf -m 2 -X POST "http://127.0.0.1:${PORT_A}/sync" -H 'content-type: application/json' -d '{}' >/dev/null
  curl -sf -m 2 -X POST "http://127.0.0.1:${PORT_B}/sync" -H 'content-type: application/json' -d '{}' >/dev/null
  pass "started leader ${LEADER_PORT}, replica-a ${PORT_A}, replica-b ${PORT_B}"
}

observe_all() {
  local index="$1"
  local out="$DATA/observe.json"
  python3 - "$index" "$LEADER_PORT" "$PORT_A" "$PORT_B" "$out" <<'PY'
import json, sys, urllib.request
index, p1, p2, p3, dest = sys.argv[1:]
nodes = []
for port in (p1, p2, p3):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/observe?index={index}", timeout=4) as res:
        nodes.append(json.load(res))
json.dump(nodes, open(dest, "w"))
PY
}

assert_present() {
  python3 - "$DATA/observe.json" "$PAYLOAD" <<'PY'
import json, sys
nodes = json.load(open(sys.argv[1]))
payload = sys.argv[2]
assert len(nodes) == 3
hashes = {node["headerHash"] for node in nodes}
assert len(hashes) == 1 and None not in hashes
for node in nodes:
    assert node["code"] == "present", node
    assert node["payload"] == payload
print(next(iter(hashes)))
PY
}

assert_pruned() {
  python3 - "$DATA/observe.json" "$HEADER" "$PAYLOAD" <<'PY'
import json, sys
nodes = json.load(open(sys.argv[1]))
header, payload = sys.argv[2], sys.argv[3]
blob = json.dumps(nodes)
assert payload not in blob
for node in nodes:
    assert node["code"] == "pruned", node
    assert node["payload"] is None
    assert node["headerHash"] == header
    assert node["bodyCommitment"]
print("pruned")
PY
}

run_all() {
  local started ended
  FAILS=0
  boot
  started="$(now_ms)"
  local append
  append="$(curl -sS -m 5 -X POST "http://127.0.0.1:${LEADER_PORT}/client/append" -H 'content-type: application/json' --data "{\"payload\":$(python3 -c 'import json,os; print(json.dumps(os.environ["PAYLOAD"]))' )}")"
  ended="$(now_ms)"
  printf 'TIME  append_ms %s\n' "$((ended - started))"
  INDEX="$(JSON="$append" python3 -c 'import json,os; print(json.loads(os.environ["JSON"]).get("index"))')"
  local status
  status="$(JSON="$append" python3 -c 'import json,os; print(json.loads(os.environ["JSON"]).get("status"))')"
  if [[ "$status" == "accepted" && "$INDEX" != "None" ]]; then
    pass "append accepted at index ${INDEX}"
  else
    bad "append status ${status}"
  fi
  observe_all "$INDEX"
  if HEADER="$(assert_present)"; then
    pass "three nodes returned the payload and the same header"
  else
    bad "observe-before"
  fi
  cp -a "$DATA/chain/nodes/replica-b" "$DATA/snap-b"
  started="$(now_ms)"
  local prune
  prune="$(curl -sS -m 5 -X POST "http://127.0.0.1:${LEADER_PORT}/client/prune" -H 'content-type: application/json' --data "{\"index\":${INDEX}}")"
  ended="$(now_ms)"
  printf 'TIME  prune_ms %s\n' "$((ended - started))"
  status="$(JSON="$prune" python3 -c 'import json,os; print(json.loads(os.environ["JSON"]).get("status"))')"
  if [[ "$status" == "accepted" ]]; then
    pass "prune accepted"
  else
    bad "prune status ${status}"
  fi
  if printf '%s' "$prune" | grep -F -q "$PAYLOAD"; then
    bad "prune response contained the payload"
  else
    pass "prune response has no payload"
  fi
  observe_all "$INDEX"
  if assert_pruned >/dev/null; then
    pass "headers remain and payloads are absent on every node"
  else
    bad "observe-after"
  fi
  HEIGHT_AFTER_PRUNE="$(curl -sf -m 2 "http://127.0.0.1:${LEADER_PORT}/health" | python3 -c 'import json,sys; print(json.load(sys.stdin)["height"])')"
  kill "$(cat "$DATA/replica-b.pid")"
  wait "$(cat "$DATA/replica-b.pid")" 2>/dev/null || true
  sleep 0.2
  local rejected
  rejected="$(curl -sS -m 5 -X POST "http://127.0.0.1:${LEADER_PORT}/client/append" -H 'content-type: application/json' --data '{"payload":"second synthetic note"}')"
  status="$(JSON="$rejected" python3 -c 'import json,os; print(json.loads(os.environ["JSON"]).get("status"))')"
  local code
  code="$(JSON="$rejected" python3 -c 'import json,os; print(json.loads(os.environ["JSON"]).get("code"))')"
  local height
  height="$(curl -sf -m 2 "http://127.0.0.1:${LEADER_PORT}/health" | python3 -c 'import json,sys; print(json.load(sys.stdin)["height"])')"
  if [[ "$status" == "rejected" && "$code" == "missing-replica" && "$height" == "$HEIGHT_AFTER_PRUNE" ]]; then
    pass "missing replica rejected the append"
  else
    bad "missing replica status=${status} code=${code} height=${height}"
  fi
  rm -rf "$DATA/chain/nodes/replica-b"
  cp -a "$DATA/snap-b" "$DATA/chain/nodes/replica-b"
  start_node replica-b "$PORT_B"
  if wait_health "http://127.0.0.1:${PORT_B}"; then
    local rejoined
    rejoined="$(curl -sS -m 4 "http://127.0.0.1:${PORT_B}/observe?index=${INDEX}")"
    if printf '%s' "$rejoined" | grep -F -q "$PAYLOAD"; then
      bad "rejoined node served the old payload"
    else
      pass "rejoined node did not serve the old payload"
    fi
    local re_code
    re_code="$(JSON="$rejoined" python3 -c 'import json,os; print(json.loads(os.environ["JSON"]).get("code"))')"
    if [[ "$re_code" == "pruned" || "$re_code" == "fail-closed" ]]; then
      pass "rejoined node result ${re_code}"
    else
      bad "rejoined node result ${re_code}"
    fi
  else
    bad "rejoined node did not start"
  fi
  local tamper
  tamper="$(curl -sS -m 4 -X POST "http://127.0.0.1:${PORT_A}/propose" -H 'content-type: application/json' --data '{"header":{"v":1,"index":9,"prev":"0000000000000000000000000000000000000000000000000000000000000000","kind":"data","body":"ab","target":null,"signer":"nope"},"signature":"aaaa","payloadB64":"YQ=="}')"
  code="$(JSON="$tamper" python3 -c 'import json,os; print(json.loads(os.environ["JSON"]).get("code"))')"
  if [[ "$code" == "unauthorized" || "$code" == "bad-signature" || "$code" == "tamper" ]]; then
    pass "tampered block rejected (${code})"
  else
    bad "tampered block code ${code}"
  fi
  if grep -F -q "$PAYLOAD" "$LOG"; then
    bad "node log contained the payload"
  else
    pass "node log has no payload"
  fi
  if grep -F -q "PRIVATE KEY" "$LOG"; then
    bad "node log contained a private key"
  else
    pass "node log has no private key"
  fi
  if grep -F -q "vault-must-stay" "$DATA/index.json" && grep -F -q "vault-must-stay" "$DATA/payloads/keep"; then
    pass "vault files outside chain/ were left in place"
  else
    bad "vault sentinel changed"
  fi
  say "Failures: ${FAILS}"
  [[ "$FAILS" -eq 0 ]]
}

menu() {
  local choice
  while true; do
    cat <<EOF

WYRVEL private chain
Block-body pruning. Not BFT. One host is one failure domain.
Payload: a synthetic note. No Monad transaction.

  1  Run every check in a fresh temp directory
  q  Quit

EOF
    printf 'Choose: '
    IFS= read -r choice || exit 0
    case "$choice" in
      1) run_all || true ;;
      q) exit 0 ;;
      *) printf 'Enter 1 or q.\n' ;;
    esac
  done
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ci|--local) MODE="run" ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
  shift
done

if [[ "$MODE" == "run" ]]; then
  run_all
else
  if [[ ! -t 0 ]]; then
    usage
    die "No terminal attached. Use --ci or --local."
  fi
  menu
fi
