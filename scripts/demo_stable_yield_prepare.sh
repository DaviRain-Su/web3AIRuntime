#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"
AMOUNT_USD="${AMOUNT_USD:-100}"
RISK="${RISK:-low}"

RESP=$(curl -s -X POST "${BASE}/v1/strategies/stable-yield/prepare" \
  -H 'content-type: application/json' \
  -d "{\"amountUsd\":${AMOUNT_USD},\"risk\":\"${RISK}\"}")

echo "$RESP" | jq '{ok,allowed,requiresApproval,preparedId,traceId,plan,policyReport,simulation:{ok,unitsConsumed,logLines:(.simulation.logs|length)}}'

TRACE=$(echo "$RESP" | jq -r '.traceId')

echo

echo "Trace (first 25 events): $TRACE"
curl -s "${BASE}/v1/traces/${TRACE}" | jq '.events[0:25]'
