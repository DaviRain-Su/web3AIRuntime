#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"
EXECUTE="${EXECUTE:-0}"

# Default: swap a tiny amount of SOL -> USDC (amount is in lamports)
AMOUNT_LAMPORTS="${AMOUNT_LAMPORTS:-1000000}"
SLIPPAGE_BPS="${SLIPPAGE_BPS:-50}"

WSOL="So11111111111111111111111111111111111111112"
USDC="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

REQ=$(cat <<JSON
{
  "chain":"solana",
  "adapter":"jupiter",
  "action":"solana.swap_exact_in",
  "params":{
    "inputMint":"${WSOL}",
    "outputMint":"${USDC}",
    "amount":"${AMOUNT_LAMPORTS}",
    "slippageBps": ${SLIPPAGE_BPS}
  }
}
JSON
)

echo "Prepare: Jupiter swap SOL->USDC"
RESP=$(curl -s -X POST "${BASE}/v1/actions/prepare" -H 'content-type: application/json' -d "$REQ")
echo "$RESP" | jq '{ok,allowed,preparedId,traceId,policyReport,simulation:{ok,unitsConsumed,logLines:(.simulation.logs|length)}}'

PREPARED=$(echo "$RESP" | jq -r '.preparedId')
TRACE=$(echo "$RESP" | jq -r '.traceId')

if [[ "$EXECUTE" != "1" ]]; then
  echo
  echo "(Not broadcasting. To broadcast set EXECUTE=1)"
  echo "TraceId: $TRACE"
  exit 0
fi

echo

echo "Execute: broadcasting tx (confirm=true)"
EXREQ=$(cat <<JSON
{ "preparedId": "${PREPARED}", "confirm": true }
JSON
)
EXRESP=$(curl -s -X POST "${BASE}/v1/actions/execute" -H 'content-type: application/json' -d "$EXREQ")
echo "$EXRESP" | jq '{ok,signature,traceId,error,policyReport}'

SIG=$(echo "$EXRESP" | jq -r '.signature // empty')
if [[ -n "$SIG" ]]; then
  echo
  echo "Solscan: https://solscan.io/tx/${SIG}"
fi

