# Solana balance

## Workflow

- `workflows/solana_balance.yaml`

Run:
```bash
node packages/runtime/dist/cli.js run workflows/solana_balance.yaml
```

## Tool

- `solana_balance`

Params:
- `address` (optional) – default: Solana CLI keypair pubkey
- `includeTokens` (optional, boolean) – include parsed SPL token accounts
- `tokenMint` (optional) – filter by mint

Artifacts:
- `balance_balance.json`
