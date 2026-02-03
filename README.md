# Web3 AI Runtime (w3rt)

Web3 AI Runtime is a Pi-SDK-based runtime that adds a **DeFi safety layer**, **workflow engine**, **wallet management**, and **trace/audit** to make web3 operations *composable, auditable, and safe-by-default*.

> Positioning: **Web3 AI Runtime = Pi SDK + DeFi Safety Layer + Web3 Tools**

## Goals
- Provide a **workflow-first** web3 execution platform (plan → compile → simulate → policy-gate → approve → execute → monitor).
- Support **both non-custodial** (BYOK / external wallet) and **custodial** (optional, policy-gated) signing modes.
- Make every operation **traceable** (run/step/tool/tx lifecycle events), **replayable**, and **verifiable** (deterministic artifact hashing).

## Who is this for? (Personas)

### 1) Desktop users (Claude Desktop / ChatGPT Desktop)
People who want an “agent that can do DeFi safely” without writing code.

What they need:
- A single tool entrypoint (ideally **MCP server**) with human-readable responses
- **Approval UX** with clear summaries: amounts, slippage, fees, allowlisted programs, simulation result
- Safe defaults: fail-closed policies on mainnet

### 2) Other agents / frameworks (agent-to-agent composition)
Strategy agents that want to delegate execution to a hardened runtime.

What they need:
- A stable **plan → compile** interface (DAG actions with `dependsOn`)
- Prepared artifacts that are easy to escrow/attest (tx payload + sim + policy decision)
- Verifiable commitments: `artifactSchemaVersion + hashAlg + artifactHash`, plus artifact fetch for recomputation

### 3) Advanced developers
Builders who want CLI + SDK primitives to embed into their own systems.

What they need:
- Scriptable CLI + HTTP daemon endpoints
- Deterministic behavior (config precedence, reproducible tests)
- Extensible adapter/driver model for new chains and protocols

### 4) Risk / custody / compliance teams (often overlooked)
Teams who care about auditability and permissioning more than “can it swap?”.

What they need:
- Explicit permission escalation via **policy = allow|confirm|block**
- Time-bounded, scoped approvals + audit trail
- Key management that supports separation-of-duties (hardware/MPC/remote signing later)

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
