#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"

AMOUNT_USD="${AMOUNT_USD:-100}"
RISK="${RISK:-low}"

curl -s -X POST "${BASE}/v1/strategies/stable-yield/plan" \
  -H 'content-type: application/json' \
  -d "{\"amountUsd\":${AMOUNT_USD},\"risk\":\"${RISK}\",\"mode\":\"deposit\"}" \
  | jq .
