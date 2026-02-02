# Solana token accounts

## Workflow

- `workflows/solana_token_accounts.yaml`

Run:
```bash
node packages/runtime/dist/cli.js run workflows/solana_token_accounts.yaml
```

## Tool

- `solana_token_accounts`

Params:
- `address` (optional) – default: Solana CLI keypair pubkey
- `tokenMint` (optional) – filter by mint
- `includeZero` (optional, boolean) – include zero-balance accounts

Artifacts:
- `token_accounts_token_accounts.json`
