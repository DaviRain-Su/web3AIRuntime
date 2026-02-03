#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"

jqcheck() { command -v jq >/dev/null 2>&1; }

echo "Health:"
curl -s "${BASE}/health" | (jqcheck && jq . || cat)

echo

echo "Prepare: Meteora DLMM open_position (simulate-only)"
REQ='{
  "chain":"solana",
  "adapter":"meteora",
  "action":"meteora.dlmm.open_position",
  "params":{
    "poolAddress":"BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh",
    "widthPct":5,
    "totalXAmount":"1000",
    "totalYAmount":"1000"
  }
}'

RESP=$(curl -s -X POST "${BASE}/v1/actions/prepare" -H 'content-type: application/json' -d "$REQ")

echo "$RESP" | (jqcheck && jq . || cat)

TRACE_ID=$(echo "$RESP" | (jqcheck && jq -r '.traceId // empty' || python - <<'PY'
import json,sys
print(json.loads(sys.stdin.read()).get('traceId',''))
PY
))

if [[ -n "$TRACE_ID" ]]; then
  echo
  echo "Trace (first 20 events): ${TRACE_ID}"
  curl -s "${BASE}/v1/traces/${TRACE_ID}" | (jqcheck && jq '.events[0:20]' || cat)
fi
