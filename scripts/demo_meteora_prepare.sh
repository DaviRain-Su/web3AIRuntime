#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"

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
echo "$RESP" | jq '{ok,allowed,preparedId,traceId,simulation:{ok,unitsConsumed,logLines:(.simulation.logs|length)},policyReport}'
TRACE=$(echo "$RESP" | jq -r '.traceId')

echo

echo "First 25 simulation logs:"
echo "$RESP" | jq -r '.simulation.logs[0:25][]'

echo

echo "TraceId: $TRACE"
