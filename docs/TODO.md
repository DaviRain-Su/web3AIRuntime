# Web3 AI Runtime (TS) — TODO

This is the running product/engineering backlog for **web3AIRuntime** (TS) aligned with the vision: **natural language → deterministic workflow → simulate → approval → execute → monitor**.

Legend:
- **P0** = must-have for a usable product MVP
- **P1** = next expansion once P0 is solid
- **P2+** = bigger surface area / strategic expansion

---

## P0 — Make swap/workflow production-grade

### Resolver + Quote
- [ ] **Scoring v1**: choose by `effectiveOut` (prefer `minOutAmount`, fallback to `outAmount`)
- [ ] **Stability penalty**: maintain per-adapter rolling window (e.g. last 20) of `ok/fail/429/timeout` and apply `stabilityPenaltyBps`
- [ ] **Explainability**: return `scoringBreakdown` and persist into `.w3rt/runs/<runId>/resolve.json`
- [ ] **Caching**: short TTL caching for resolve results (by inputMint/outputMint/amount/slippage) to reduce RPC pressure

### Confirmation UX
- [ ] **Unified confirmation summary** for funds-moving steps:
  - input/output mint, inAmount
  - expectedOut + minOut
  - chosen venue + confidence + explain
  - estimated fees / ATA creation warnings (best-effort)

### Reliability
- [ ] **RPC strategy**: support paid RPC (Helius/QuickNode/Alchemy) + backoff + rate-limit guard
- [ ] **Run state**: persist run status (`pending/needs_confirm/executed/failed`) per `runId`

---

## P1 — DEX expansion (better routing)

- [ ] **Orca Whirlpools** adapter + resolver integration
- [ ] Add venue health scoring (timeouts/429 degrade) and automatic fallback
- [ ] Multi-hop routing awareness (where supported) + route constraints

---

## P2 — Lending / Yield (asset management)

- [ ] **Kamino**: deposit/withdraw/borrow/repay intents + deterministic adapter execution
- [ ] **Lulo**: yield-optimizer resolver (choose best lending venue)
- [ ] Consolidate lending actions into chain-agnostic intents (`lend.deposit`, `lend.withdraw`, ...)

---

## P3 — Perps / Derivatives

- [ ] **Drift**: open/close positions, leverage, margin adjust, TP/SL workflows
- [ ] Perps safety rules: max leverage, max notional, liquidation buffer checks

---

## P4 — Cross-chain + account security

- [ ] **deBridge**: bridge intents + confirmations
- [ ] **Squads**: multisig / smart account execution (team approvals)

---

## Infra / Ops (ongoing)

- [ ] CI: add a real minimal resolver unit test (mocked quotes)
- [ ] Add structured error codes for resolver/compile/execute paths
- [ ] Add metrics endpoints for adapter success rate / 429 rate
