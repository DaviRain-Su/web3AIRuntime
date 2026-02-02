# MVP Plan (Solana-first)

## Goal
Ship a usable **w3rt CLI** that can perform a safe-by-default Solana swap workflow.

## MVP workflow: `solana_swap_exact_in`
- quote (Jupiter)
- build tx
- simulate
- approval
- sign
- send
- confirm

## Policies (MVP)
- mainnet requires approval
- require simulation before broadcast
- max slippage + max single USD amount
- program allowlist (Jupiter, SPL Token, System, ComputeBudget)

## Trace (MVP)
- run/step/tool events into JSONL
- artifacts saved locally

## CLI commands (MVP)
- `w3rt run workflows/solana_swap_exact_in.yml`
- `w3rt trace <runId>`
- `w3rt policy show`
- `w3rt approve <runId>` (stub)

## Success criteria
- deterministically reproducible run logs (given same artifacts)
- safe defaults: no mainnet broadcast without approval
