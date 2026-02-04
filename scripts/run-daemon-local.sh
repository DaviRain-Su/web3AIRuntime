#!/usr/bin/env bash
set -euo pipefail

export W3RT_SOLANA_RPC_URL="${W3RT_SOLANA_RPC_URL:-https://gayleen-v43l6p-fast-mainnet.helius-rpc.com}"
export W3RT_DAEMON_HOST="${W3RT_DAEMON_HOST:-127.0.0.1}"
export W3RT_DAEMON_PORT="${W3RT_DAEMON_PORT:-8787}"

# Optional safety knobs
export W3RT_RESOLVE_CACHE_TTL_MS="${W3RT_RESOLVE_CACHE_TTL_MS:-4000}"
export W3RT_ADAPTER_COOLDOWN_MS="${W3RT_ADAPTER_COOLDOWN_MS:-2500}"
export W3RT_QUOTE_CONCURRENCY="${W3RT_QUOTE_CONCURRENCY:-1}"
export W3RT_HTTP_RPS="${W3RT_HTTP_RPS:-8}"
export W3RT_HTTP_BURST="${W3RT_HTTP_BURST:-8}"

cd "$(dirname "$0")/.."

exec bun packages/runtime/dist/cli.js daemon
