# Architecture (derived from spec.md)

This document turns **docs/spec.md** into an implementable architecture.

## Layering

1. **Pi SDK layer (upstream, reused)**
   - session manager, extension runner, TUI, model routing

2. **Web3 layer (ours)**
   - Policy Runtime (safety gates)
   - Wallet Manager (key modes)
   - Trace Runtime (audit + replay)
   - Workflow Engine (multi-step orchestration)
   - Chain Adapters (solana/sui/evm)
   - Web3 Extensions (Pi extensions exposing tools/commands)

## Core execution loop (high level)

User intent → select workflow → execute stages:
- *analysis*: read-only tools (quote, balances, price check)
- *simulation*: build tx + simulate
- *approval*: user approval gates (mainnet + policy decisions)
- *execution*: sign + send
- *monitor*: confirm + post-checks

## Cross-cutting concerns

### Policy-first
- Every **side-effect** (sign/send) must be policy gated.
- Policy decisions must be **structured**, not just UI messages.

### Trace-first
- Every run produces a runId.
- Every stage/action emits trace events.
- Large artifacts live in `.w3rt/runs/<runId>/artifacts/*`.

### Key modes
- **Default**: non-custodial (external wallet or local keystore)
- Optional: custodial/session-keys (must be strict-policy)

## Package map (monorepo)
- `@w3rt/core`: CLI + runtime bootstrap
- `@w3rt/policy`: policy types + engine + Pi extension hook
- `@w3rt/trace`: event schema + local store + export
- `@w3rt/workflow`: workflow types + parser + scheduler + executor
- `@w3rt/chains`: chain adapter interfaces + implementations

## MVP scope (Solana-first)
- One workflow: `solana_swap_exact_in` (Jupiter)
- Policy: mainnet gate + program allowlist + amount/slippage limits + require simulation
- Trace: JSONL + artifacts, plus `w3rt trace <runId>`
