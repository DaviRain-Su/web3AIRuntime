# Policy Runtime

This is the **core differentiator** of Web3 AI Runtime.

## Goals
- Make mainnet operations safe-by-default.
- Provide deterministic, auditable decisions.
- Separate **decision** (engine) from **UI** (TUI prompts).

## Policy decision contract
Policy returns a structured decision:
- `allow`
- `warn`
- `confirm` (requires user approval)
- `block`

Each decision must include a stable `code` for analytics and replay.

## Inputs
Policy consumes a `PolicyContext` extracted from:
- tool meta (chain, sideEffect, action)
- tool params (amount, token/program ids)
- workflow state (network, run mode)

## Required gates (MVP)
1. **Mainnet gate**
   - mainnet enabled?
   - require approval?

2. **Require simulation**
   - if a tool is `sideEffect=broadcast`, policy should require `simResult.ok == true` artifact.

3. **Allowlist**
   - allow by `action` and `programId` (Solana) / `packageId` (Sui) / `contract` (EVM).

4. **Limits**
   - maxSingleUsd
   - maxSlippageBps

## Rule language (future)
Spec uses `condition: string`. For MVP this may be allowed, but long-term we should replace with:
- JSON DSL, or
- CEL with a safe interpreter

## Policy extension hook (Pi)
Implementation approach:
- intercept `pre_tool_call` for web3 tools
- emit `policy.decision` trace
- block/confirm before high-risk steps
