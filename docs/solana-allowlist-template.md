# Solana allowlist template (MVP)

This is a **starting template** for `policy.yaml`.

> Note: Jupiter swaps may involve additional programs depending on route. The recommended flow is:
> 1) Run a small swap once
> 2) Use `w3rt policy suggest --from-run <runId>`
> 3) Paste the resulting programs into your allowlist

## Minimum common programs

```yaml
allowlist:
  solanaPrograms:
    # System program (create accounts, transfers)
    - "11111111111111111111111111111111"

    # Compute budget
    - "ComputeBudget111111111111111111111111111111"

    # SPL Token
    - "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

    # Associated Token Account program
    - "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
```

## Example: enable allowlist enforcement

```yaml
networks:
  mainnet:
    enabled: true
    requireApproval: true
    requireSimulation: true
    maxDailyVolumeUsd: 500
  testnet:
    enabled: true
    requireApproval: false

transactions:
  maxSingleAmountUsd: 500
  maxSlippageBps: 50
  requireConfirmation: large

allowlist:
  actions: ["swap", "confirm", "quote", "build_tx", "simulate"]
  solanaPrograms:
    - "11111111111111111111111111111111"
    - "ComputeBudget111111111111111111111111111111"
    - "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    - "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"

rules: []
```
