#!/usr/bin/env bash
set -euo pipefail

# Demo: compile + dryrun via HTTP

HOST=${W3RT_API_HOST:-127.0.0.1}
PORT=${W3RT_API_PORT:-8787}

WF='{"name":"api-demo","actions":[{"id":"swap_quote","tool":"w3rt_swap_quote","params":{"from":"SOL","to":"USDC","amount":"0.01","slippageBps":50,"allowFallback":true},"dependsOn":[]},{"id":"swap_exec","tool":"w3rt_swap_exec","params":{"confirm":"I_CONFIRM"},"dependsOn":["swap_quote"]}]}'

echo "Compile..."
PLAN=$(curl -sS -X POST "http://${HOST}:${PORT}/compile" -H 'content-type: application/json' -d "{\"workflowJson\":${WF}}" | jq -c '.plan')

echo "Dry-run..."
curl -sS -X POST "http://${HOST}:${PORT}/dryrun" -H 'content-type: application/json' -d "{\"plan\":${PLAN}}" | jq -r '.summary'
