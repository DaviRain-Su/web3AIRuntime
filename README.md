# Web3 AI Runtime (w3rt)

Web3 AI Runtime is a Pi-SDK-based runtime that adds a **DeFi safety layer**, **workflow engine**, **wallet management**, and **trace/audit** to make web3 operations *composable, auditable, and safe-by-default*.

> Positioning: **Web3 AI Runtime = Pi SDK + DeFi Safety Layer + Web3 Tools**

## Goals
- Provide a **workflow-first** web3 execution platform (plan → simulate → approve → execute → monitor).
- Support **both non-custodial** (BYOK / external wallet) and **custodial** (optional, policy-gated) signing modes.
- Make every operation **traceable** (run/step/tool/tx lifecycle events) and **replayable**.

## MVP (Solana-first)
Initial target workflows:
- `solana_swap_exact_in` (Jupiter): quote → build → simulate → approve → send → confirm → report

## Monorepo Layout
- `packages/core` – CLI (`w3rt`) + runtime bootstrap
- `packages/policy` – Policy Runtime (gates, allowlists, limits, rule DSL)
- `packages/wallet` – Wallet Manager (key modes, encryption, profiles)
- `packages/chains` – Chain adapters (solana/sui/evm)
- `packages/trace` – Trace Runtime (events + artifacts)
- `packages/workflow` – Workflow engine + scheduler
- `packages/skills` – DeFi skills and protocol guides

## Development
```bash
npm install
npm run build
npm run test
```

## Status
Scaffolded repository (v0). Next: implement the core run/trace schema, policy decision contract, and a first Solana workflow.
